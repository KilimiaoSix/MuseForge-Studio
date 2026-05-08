import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "@sd-agent-studio/model-providers";
import { normalizeGenerationPlan } from "@sd-agent-studio/shared";
import { loadEnvFile } from "./env.js";
import {
  deleteGeneration,
  deleteGenerations,
  deleteProviderProfile,
  getAppSettings,
  getActiveProviderProfile,
  getGeneration,
  getProviderProfile,
  insertProviderProfile,
  listGenerations,
  listProviderProfiles,
  listResourceIndex,
  listResourceProfiles,
  activateProviderProfile,
  profileToProviderConfig,
  updateProviderProfile,
  updateProviderTestStatus,
  updateAppSettings,
  updateGeneration,
  updateResourceProfile,
  updateResourcePurpose,
  upsertResourceProfiles,
  upsertResources,
} from "./db.js";
import { getBackendName, getEngineModels, getEngineStatus, loadEngineManifest, unloadA1111Model } from "./engines.js";
import {
  importControlNetResource,
  listControlNetPresets,
  profilesFromControlNetPresets,
} from "./controlnet-resources.js";
import {
  addLoraProjectAssets,
  createLoraProject,
  createLoraTrainingPlan,
  getLoraProject,
  inspectLoraProject,
  installLoraProject,
  listLoraProjects,
  updateLoraCaptions,
} from "./lora-training.js";
import { getKohyaInstallTask, getKohyaStatus, installKohyaRuntime } from "./kohya-installer.js";
import { deleteLocalLlmModel, getLocalLlmInstallTask, getLocalLlmPullTask, getLocalLlmStatus, installLocalLlmRuntime, listLocalLlmPullTasks, localGemmaProvider, pullGemmaModel, pullLocalLlmModel, searchOllamaLibrary, getOllamaModelInfo, stopLocalLlmModel } from "./local-llm.js";
import {
  compactModelContextForPlanning,
  compatibleLorasForCheckpoint,
  profilesFromResources,
  resolvePlanRuntimeResources,
  validateGenerationPlanResources,
} from "./resource-compat.js";
import {
  cancelGenerationTask,
  createControlNetInstallTask,
  createGenerationTask,
  createLoraTrainingTask,
  getGenerationTask,
  listGenerationTasks,
  restoreInterruptedTasks,
  retryGenerationTask,
} from "./tasks.js";

loadEnvFile();

const host = process.env.SD_AGENT_HOST || "127.0.0.1";
const port = Number(process.env.SD_AGENT_PORT || 8787);
const webuiBaseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const generationOutputDir = join(projectRoot, "outputs", "generations");
const controlNetReferenceDir = join(projectRoot, "outputs", "controlnet");
const promptTagCache = new Map();
const ResourceInstallTypes = Object.freeze({
  checkpoint: { dirKey: "checkpoints", extensions: [".safetensors", ".ckpt"] },
  lora: { dirKey: "loras", extensions: [".safetensors", ".pt"] },
  vae: { dirKey: "vae", extensions: [".safetensors", ".ckpt", ".pt"] },
  controlnet: { dirKey: "controlnet", extensions: [".safetensors", ".pth", ".pt"] },
});
if (process.argv.includes("--check")) {
  console.log("backend scaffold ok");
  process.exit(0);
}

restoreInterruptedTasks();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(res, ["RESOURCE_COMPATIBILITY_ERROR", "BAD_REQUEST"].includes(error.code) ? 400 : 500, {
      error: {
        code: error.code || "INTERNAL_ERROR",
        message: error.message,
        compatibility: error.compatibility,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      },
    });
  }
});

server.listen(port, host, () => {
  console.log(`SD Agent Studio backend listening on http://${host}:${port}`);
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === "OPTIONS") {
    sendCors(res, 204);
    res.end();
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/outputs/generations/")) {
    await sendOutputImageFile(req, res, url.pathname, generationOutputDir);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/outputs/controlnet/")) {
    await sendOutputImageFile(req, res, url.pathname, controlNetReferenceDir);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const engineStatus = await getEngineStatus();
    const providerStatus = getProviderStatus();
    sendJson(res, 200, {
      ok: true,
      inferenceBackend: getBackendName(),
      webuiBaseUrl,
      provider: providerStatus.type,
      providerStatus,
      engines: engineStatus.engines,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/prompt-tools/tags") {
    const query = url.searchParams.get("q") || "";
    const locale = url.searchParams.get("locale") || "zh_CN";
    const groupId = url.searchParams.get("groupId") || "";
    const limit = clampInteger(url.searchParams.get("limit"), 20, 500, 180);
    sendJson(res, 200, await getPromptAllInOneTags({ query, locale, groupId, limit }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/plan") {
    const body = await readJson(req);
    sendJson(res, 200, await runTagGenerationPlanner({
      userRequest: body.userRequest || "",
      providerOverride: body.provider,
      modelContextOverride: body.modelContext,
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/revise") {
    const body = await readJson(req);
    const currentPlan = normalizeGenerationPlan(body.plan || {});
    sendJson(res, 200, await runTagGenerationPlanner({
      userRequest: buildReviseUserRequest({ currentPlan, conversation: body.conversation || [], userRequest: body.userRequest || "" }),
      currentPlan,
      providerOverride: body.provider,
      modelContextOverride: body.modelContext,
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/run") {
    const body = await readJson(req);
    const plan = preparePlanForGeneration(body.plan || {});
    const task = createGenerationTask({
      plan,
    });
    sendJson(res, 202, { task, taskId: task.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/generate") {
    const body = await readJson(req);
    const plan = preparePlanForGeneration(body.plan || {});
    const task = createGenerationTask({
      plan,
      parentTaskId: body.parentTaskId || "",
    });
    sendJson(res, 202, { task, taskId: task.id });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(res, 200, {
      tasks: listGenerationTasks({
        limit: clampInteger(url.searchParams.get("limit"), 1, 100, 30),
        offset: clampInteger(url.searchParams.get("offset"), 0, 100000, 0),
      }),
    });
    return;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const task = getGenerationTask(taskMatch[1]);
    if (!task) {
      sendJson(res, 404, { error: { message: "Task not found" } });
      return;
    }
    sendJson(res, 200, { task });
    return;
  }

  const taskActionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(cancel|retry)$/);
  if (req.method === "POST" && taskActionMatch) {
    const [, taskId, action] = taskActionMatch;
    const task = action === "cancel"
      ? await cancelGenerationTask(taskId)
      : retryGenerationTask(taskId, { preparePlan: preparePlanForGeneration });
    if (!task) {
      sendJson(res, 404, { error: { message: "Task not found" } });
      return;
    }
    sendJson(res, action === "retry" ? 202 : 200, { task, taskId: task.id });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models/local") {
    sendJson(res, 200, await buildModelContext());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/engines/status") {
    sendJson(res, 200, await getEngineStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/engines/models") {
    sendJson(res, 200, await getEngineModels());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    const resources = await buildResources();
    sendJson(res, 200, resources);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resources/scan") {
    const resources = await buildResources({ refreshIndex: true });
    sendJson(res, 200, resources);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resources/install") {
    const body = await readJson(req);
    const installed = await installLocalResources(body);
    sendJson(res, 201, { installed, resources: await buildResources({ refreshIndex: true }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/controlnet/reference-images") {
    const body = await readJson(req);
    const reference = await saveControlNetReferenceImage(body);
    sendJson(res, 201, { reference });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/controlnet/presets") {
    sendJson(res, 200, await listControlNetPresets());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/controlnet/extension/install") {
    const task = createControlNetInstallTask({ presetId: "extension" });
    sendJson(res, 202, { task, taskId: task.id });
    return;
  }

  const controlPresetInstallMatch = url.pathname.match(/^\/api\/controlnet\/presets\/([^/]+)\/install$/);
  if (req.method === "POST" && controlPresetInstallMatch) {
    const task = createControlNetInstallTask({ presetId: decodeURIComponent(controlPresetInstallMatch[1]) });
    sendJson(res, 202, { task, taskId: task.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/controlnet/import") {
    const body = await readJson(req);
    const result = await importControlNetResource(body);
    sendJson(res, 201, { ...result, resources: await buildResources({ refreshIndex: true }) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/controlnet/resources") {
    const resources = await buildResources({ refreshIndex: url.searchParams.get("scan") === "1" });
    sendJson(res, 200, {
      resources: resources.a1111.controlnet,
      extension: resources.a1111.controlnetExtension || { installed: false, models: [], modules: [] },
      profiles: resources.profiles.filter((profile) => profile.type === "controlnet"),
      presets: (await listControlNetPresets()).presets,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/controlnet/resources/scan") {
    const resources = await buildResources({ refreshIndex: true });
    sendJson(res, 200, {
      resources: resources.a1111.controlnet,
      extension: resources.a1111.controlnetExtension || { installed: false, models: [], modules: [] },
      profiles: resources.profiles.filter((profile) => profile.type === "controlnet"),
      presets: (await listControlNetPresets()).presets,
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/resources/profile") {
    const body = await readJson(req);
    const profile = updateResourceProfile(body.type || "", body.name || "", normalizeResourceProfilePatch(body));
    if (!profile) {
      sendJson(res, 404, { error: { message: "Resource profile not found" } });
      return;
    }
    sendJson(res, 200, { profile, resources: await buildResources() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resources/validate-plan") {
    const body = await readJson(req);
    const plan = normalizeGenerationPlan(body.plan || {});
    sendJson(res, 200, { compatibility: validatePlan(plan) });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/resources/purpose") {
    const body = await readJson(req);
    updateResourcePurpose(body.type || "", body.name || "", body.purpose || "");
    sendJson(res, 200, { resources: listResourceIndex() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/generations") {
    sendJson(res, 200, {
      generations: listGenerations({
        limit: clampInteger(url.searchParams.get("limit"), 1, 100, 40),
        offset: clampInteger(url.searchParams.get("offset"), 0, 100000, 0),
      }),
    });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/generations") {
    const body = await readJson(req);
    const deleted = deleteGenerations(Array.isArray(body.ids) ? body.ids : [], {
      deleteFiles: body.deleteFiles !== false,
    });
    sendJson(res, 200, { deleted });
    return;
  }

  const generationMatch = url.pathname.match(/^\/api\/generations\/([^/]+)$/);
  const generationOpenMatch = url.pathname.match(/^\/api\/generations\/([^/]+)\/open$/);
  if (req.method === "POST" && generationOpenMatch) {
    const generation = getGeneration(generationOpenMatch[1]);
    if (!generation) {
      sendJson(res, 404, { error: { message: "Generation not found" } });
      return;
    }
    const opened = await openGenerationInFileManager(generation);
    sendJson(res, 200, opened);
    return;
  }

  if (req.method === "GET" && generationMatch) {
    const generation = getGeneration(generationMatch[1]);
    if (!generation) {
      sendJson(res, 404, { error: { message: "Generation not found" } });
      return;
    }
    sendJson(res, 200, { generation });
    return;
  }

  if (req.method === "PUT" && generationMatch) {
    const body = await readJson(req);
    const generation = updateGeneration(generationMatch[1], body || {});
    if (!generation) {
      sendJson(res, 404, { error: { message: "Generation not found" } });
      return;
    }
    sendJson(res, 200, { generation });
    return;
  }

  if (req.method === "DELETE" && generationMatch) {
    const generation = deleteGeneration(generationMatch[1], {
      deleteFiles: url.searchParams.get("deleteFiles") !== "false",
    });
    if (!generation) {
      sendJson(res, 404, { error: { message: "Generation not found" } });
      return;
    }
    sendJson(res, 200, { deleted: generation });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/providers/status") {
    sendJson(res, 200, getProviderStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings/runtime") {
    sendJson(res, 200, { settings: getAppSettings() });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/runtime") {
    const body = await readJson(req);
    sendJson(res, 200, { settings: updateAppSettings(body || {}) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/providers") {
    sendJson(res, 200, {
      providers: listProviderProfiles().map(sanitizeProviderProfile),
      active: getProviderStatus(),
      defaults: {
        localGemma: localGemmaProvider,
      },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/providers") {
    const body = await readJson(req);
    const profile = insertProviderProfile(normalizeProviderInput({
      ...body,
      id: randomUUID(),
      isActive: Boolean(body.isActive),
    }));
    sendJson(res, 201, { provider: sanitizeProviderProfile(profile), active: getProviderStatus() });
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
  if (req.method === "PUT" && providerMatch) {
    const body = await readJson(req);
    const profile = updateProviderProfile(providerMatch[1], normalizeProviderInput(body, { partial: true }));
    if (!profile) {
      sendJson(res, 404, { error: { message: "Provider profile not found" } });
      return;
    }
    sendJson(res, 200, { provider: sanitizeProviderProfile(profile), active: getProviderStatus() });
    return;
  }

  if (req.method === "DELETE" && providerMatch) {
    const profile = deleteProviderProfile(providerMatch[1]);
    if (!profile) {
      sendJson(res, 404, { error: { message: "Provider profile not found" } });
      return;
    }
    sendJson(res, 200, { deleted: sanitizeProviderProfile(profile), active: getProviderStatus() });
    return;
  }

  const providerActionMatch = url.pathname.match(/^\/api\/providers\/([^/]+)\/(activate|test)$/);
  if (req.method === "POST" && providerActionMatch) {
    const [, providerId, action] = providerActionMatch;
    const profile = action === "activate"
      ? activateProviderProfile(providerId)
      : await testProviderProfile(providerId);
    if (!profile) {
      sendJson(res, 404, { error: { message: "Provider profile not found" } });
      return;
    }
    sendJson(res, 200, { provider: sanitizeProviderProfile(profile), active: getProviderStatus() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/providers/test") {
    sendJson(res, 200, await testProvider());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/providers/config") {
    const body = await readJson(req);
    const activeProfile = getActiveProviderProfile();
    const profile = activeProfile
      ? updateProviderProfile(activeProfile.id, normalizeProviderInput(body, { partial: true }))
      : insertProviderProfile(normalizeProviderInput({ ...body, id: randomUUID(), isActive: true }));
    sendJson(res, 200, { provider: sanitizeProviderProfile(profile), active: getProviderStatus() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-llm/status") {
    sendJson(res, 200, await getLocalLlmStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-llm/install") {
    sendJson(res, 200, { task: getLocalLlmInstallTask() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local-llm/install") {
    sendJson(res, 202, await installLocalLlmRuntime());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-llm/library") {
    sendJson(res, 200, await searchOllamaLibrary(url.searchParams.get("q") || ""));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-llm/model-info") {
    sendJson(res, 200, await getOllamaModelInfo(url.searchParams.get("model") || ""));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-llm/pulls") {
    sendJson(res, 200, { tasks: listLocalLlmPullTasks({ limit: clampInteger(url.searchParams.get("limit"), 1, 100, 20) }) });
    return;
  }

  const localPullMatch = url.pathname.match(/^\/api\/local-llm\/pulls\/([^/]+)$/);
  if (req.method === "GET" && localPullMatch) {
    const task = getLocalLlmPullTask(localPullMatch[1]);
    if (!task) {
      sendJson(res, 404, { error: { message: "Pull task not found" } });
      return;
    }
    sendJson(res, 200, { task });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local-llm/pull-gemma") {
    sendJson(res, 202, await pullGemmaModel());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local-llm/pull") {
    const body = await readJson(req);
    sendJson(res, 202, await pullLocalLlmModel(body.model || body.name || "", { force: Boolean(body.force) }));
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/local-llm/models/")) {
    const model = decodeURIComponent(url.pathname.slice("/api/local-llm/models/".length));
    sendJson(res, 200, await deleteLocalLlmModel(model));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/kohya/status") {
    sendJson(res, 200, await getKohyaStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/kohya/install") {
    sendJson(res, 200, { task: getKohyaInstallTask() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/kohya/install") {
    sendJson(res, 202, await installKohyaRuntime());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/lora/plan") {
    const body = await readJson(req);
    sendJson(res, 200, {
      plan: createMockLoraPlan(body.projectName || "new_lora"),
      note: "This is a scaffold response. Connect kohya_ss or sd-scripts in the next implementation pass.",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lora/projects") {
    sendJson(res, 200, { projects: await listLoraProjects() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/lora/projects") {
    const body = await readJson(req);
    sendJson(res, 201, { project: await createLoraProject(body) });
    return;
  }

  const loraProjectMatch = url.pathname.match(/^\/api\/lora\/projects\/([^/]+)$/);
  if (req.method === "GET" && loraProjectMatch) {
    sendJson(res, 200, { project: await getLoraProject(loraProjectMatch[1]) });
    return;
  }

  const loraProjectActionMatch = url.pathname.match(/^\/api\/lora\/projects\/([^/]+)\/(assets|inspect|captions|plan|train|install)$/);
  if (loraProjectActionMatch) {
    const [, projectId, action] = loraProjectActionMatch;
    const body = req.method === "GET" ? {} : await readJson(req);
    if (req.method === "POST" && action === "assets") {
      sendJson(res, 201, await addLoraProjectAssets(projectId, body));
      return;
    }
    if (req.method === "POST" && action === "inspect") {
      sendJson(res, 200, await inspectLoraProject(projectId));
      return;
    }
    if (req.method === "PUT" && action === "captions") {
      sendJson(res, 200, await updateLoraCaptions(projectId, body));
      return;
    }
    if (req.method === "POST" && action === "plan") {
      sendJson(res, 200, await createLoraTrainingPlan(projectId, body));
      return;
    }
    if (req.method === "POST" && action === "train") {
      const task = createLoraTrainingTask({ projectId });
      sendJson(res, 202, { task, taskId: task.id });
      return;
    }
    if (req.method === "POST" && action === "install") {
      sendJson(res, 200, await installLoraProject(projectId));
      return;
    }
  }

  sendJson(res, 404, { error: { message: "Not found" } });
}

async function buildModelContext() {
  const engineModels = await getEngineModels().catch(() => null);
  const a1111Models = engineModels?.engines?.a1111?.models || {};
  const a1111Checkpoints = a1111Models.checkpoints || [];
  const root = process.env.SD_WEBUI_ROOT || findLikelyWebuiRoot();
  const scan = async (relativePath, extensions) => scanFiles(join(root, relativePath), extensions);

  const context = {
    webuiRoot: root,
    checkpoints: preferDefaultCheckpoint(a1111Checkpoints.length ? a1111Checkpoints : await scan("models/Stable-diffusion", [".safetensors", ".ckpt"])),
    loras: a1111Models.loras?.length ? a1111Models.loras : await scan("models/Lora", [".safetensors", ".pt"]),
    vaes: a1111Models.vaes?.length ? a1111Models.vaes : await scan("models/VAE", [".safetensors", ".ckpt", ".pt"]),
    controlnet: a1111Models.controlnet?.length ? a1111Models.controlnet : await scan("models/ControlNet", [".safetensors", ".pth", ".pt"]),
    samplers: a1111Models.samplers || [],
    upscalers: a1111Models.upscalers || [],
    promptTools: engineModels?.engines?.a1111?.promptTools || detectPromptTools(root),
  };
  ensureResourceProfilesFromModelContext(context);
  return compactModelContextForPlanning(context, listResourceProfiles());
}

function preferDefaultCheckpoint(checkpoints = []) {
  const defaultCheckpoint = getAppSettings().defaultCheckpoint || "";
  if (!defaultCheckpoint || !Array.isArray(checkpoints) || !checkpoints.length) return checkpoints;
  const wanted = normalizeResourceLookupName(defaultCheckpoint);
  const index = checkpoints.findIndex((checkpoint) => [checkpoint.title, checkpoint.name, checkpoint.filename]
    .map(normalizeResourceLookupName)
    .some((value) => value && (value === wanted || value.includes(wanted) || wanted.includes(value))));
  if (index <= 0) return checkpoints;
  return [checkpoints[index], ...checkpoints.slice(0, index), ...checkpoints.slice(index + 1)];
}

async function buildResources({ refreshIndex = false } = {}) {
  const engineModels = await getEngineModels();
  const a1111 = engineModels.engines.a1111;
  const models = a1111.models || {};
  const resources = {
    backend: engineModels.defaultBackend,
    a1111: {
      running: a1111.running,
      baseUrl: a1111.baseUrl,
      checkpoints: models.checkpoints || [],
      loras: models.loras || [],
      vaes: models.vaes || [],
      samplers: models.samplers || [],
      upscalers: models.upscalers || [],
      controlnet: models.controlnet || [],
      controlnetExtension: models.controlnetExtension || { installed: false, models: [], modules: [] },
      options: models.options || {},
      modelDirs: a1111.modelDirs || {},
      promptTools: a1111.promptTools || detectPromptTools(a1111.path),
    },
    index: listResourceIndex(),
  };

  if (refreshIndex || !resources.index.length) {
    upsertResources([
      ...resources.a1111.checkpoints.map((item) => toResource("checkpoint", item)),
      ...resources.a1111.loras.map((item) => toResource("lora", item)),
      ...resources.a1111.vaes.map((item) => toResource("vae", item)),
      ...resources.a1111.samplers.map((item) => toResource("sampler", item)),
      ...resources.a1111.controlnet.map((item) => toResource("controlnet", item)),
    ]);
    upsertResourceProfiles(profilesFromResources(resources));
    upsertResourceProfiles(profilesFromControlNetPresets(resources.a1111.controlnet));
    resources.index = listResourceIndex();
  }

  ensureResourceProfilesFromResources(resources);
  upsertResourceProfiles(profilesFromControlNetPresets(resources.a1111.controlnet));
  resources.profiles = listResourceProfiles();
  resources.compatibility = buildResourceCompatibilitySummary(resources.profiles);

  return resources;
}

function toResource(type, item = {}) {
  return {
    type,
    name: item.name || item.title || item.filename || "",
    title: item.title || item.alias || item.name || "",
    source: item.source || "",
    path: item.path || item.filename || "",
  };
}

async function installLocalResources(input = {}) {
  const files = normalizeInstallFiles(input);
  if (!files.length) throw badRequest("请选择要安装的模型文件。");

  const installed = [];
  for (const file of files) {
    const uploadContent = decodeUploadContent(file);
    const sourcePath = uploadContent ? "" : resolve(String(file.path || ""));
    const sourceStat = uploadContent ? { size: uploadContent.length } : await stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile && !uploadContent) throw badRequest(`文件不存在或不可读取：${file.path || ""}`);

    const sourceName = file.name || file.filename || basename(sourcePath);
    const sourceExtension = extname(sourceName || sourcePath).toLowerCase();
    const resourceType = inferInstallResourceType(file, sourceName || sourcePath, input.type);
    const allowedExtensions = ResourceInstallTypes[resourceType].extensions;
    if (!allowedExtensions.includes(sourceExtension)) {
      throw badRequest(`${resourceType} 不支持 ${sourceExtension || "无扩展名"} 文件。`);
    }

    const targetDir = await resolveResourceInstallDir(resourceType);
    mkdirSync(targetDir, { recursive: true });

    const filename = sanitizeResourceFilename(sourceName);
    if (extname(filename).toLowerCase() !== sourceExtension) {
      throw badRequest(`文件名扩展名与源文件不一致：${filename}`);
    }

    const destinationPath = await uniqueDestinationPath(targetDir, filename, Boolean(input.overwrite));
    if (sourcePath && sourcePath === destinationPath) {
      installed.push({
        type: resourceType,
        name: basename(destinationPath),
        path: destinationPath,
        size: sourceStat.size,
        skipped: true,
        message: "文件已在目标目录",
      });
      continue;
    }

    if (uploadContent) {
      await writeFile(destinationPath, uploadContent);
    } else {
      await copyFile(sourcePath, destinationPath);
    }
    installed.push({
      type: resourceType,
      name: basename(destinationPath),
      path: destinationPath,
      size: sourceStat.size,
      skipped: false,
    });
  }

  return installed;
}

function decodeUploadContent(file = {}) {
  const raw = file.contentBase64 || file.dataBase64 || "";
  const dataUrl = file.dataUrl || "";
  const source = raw || dataUrl;
  if (!source) return null;
  const base64 = String(source).replace(/^data:[^;]+;base64,/, "");
  if (!base64) return null;
  return Buffer.from(base64, "base64");
}

function inferInstallResourceType(file = {}, sourcePath = "", fallbackType = "") {
  if (file.type || fallbackType) return normalizeInstallResourceType(file.type || fallbackType);

  const extension = extname(sourcePath).toLowerCase();
  const text = `${sourcePath} ${file.name || ""}`.toLowerCase().replace(/\\/g, "/");
  if (/(^|\/)(stable-diffusion|checkpoints?|sd-models?)(\/|$)/.test(text)) return "checkpoint";
  if (/(^|\/)(lora|loras|lycoris|locon)(\/|$)/.test(text)) return "lora";
  if (/(^|\/)(vae|vae-approx)(\/|$)/.test(text)) return "vae";
  if (/(^|\/)(controlnet|control-net|control_net)(\/|$)/.test(text)) return "controlnet";
  if (/(^|[._ -])(vae|kl-f8|vae-ft)([._ -]|$)/.test(text)) return "vae";
  if (/(^|[._ -])(controlnet|control-net|control_net|canny|depth|openpose|lineart|scribble|tile|ip-adapter)([._ -]|$)/.test(text)) return "controlnet";
  if (/(^|[._ -])(lora|lycoris|locon)([._ -]|$)/.test(text)) return "lora";

  if (extension === ".pth") return "controlnet";
  throw badRequest(`无法识别资源类型：${basename(sourcePath)}，请先选择 Checkpoint、LoRA、VAE 或 ControlNet。`);
}

function normalizeInstallResourceType(value) {
  const type = String(value || "checkpoint").toLowerCase();
  if (!ResourceInstallTypes[type]) throw badRequest(`不支持的资源类型：${value || ""}`);
  return type;
}

function normalizeInstallFiles(input = {}) {
  if (Array.isArray(input.files)) return input.files;
  if (input.path) return [{ path: input.path, name: input.name }];
  return [];
}

async function resolveResourceInstallDir(resourceType) {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines?.a1111;
  const installRoot = resolve(projectRoot, manifest.installDir || "vendor/engines");
  const enginePath = process.env.SD_WEBUI_ROOT
    ? resolve(process.env.SD_WEBUI_ROOT)
    : join(installRoot, engine?.directory || "stable-diffusion-webui");
  const relativeDir = engine?.modelDirs?.[ResourceInstallTypes[resourceType].dirKey];
  if (!relativeDir) throw badRequest(`未配置 ${resourceType} 的安装目录。`);
  return join(enginePath, relativeDir);
}

async function uniqueDestinationPath(targetDir, filename, overwrite = false) {
  const destinationPath = join(targetDir, filename);
  if (!isPathInside(destinationPath, targetDir)) throw badRequest("文件名不安全。");
  if (overwrite || !existsSync(destinationPath)) return destinationPath;

  const extension = extname(filename);
  const stem = basename(filename, extension);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = join(targetDir, `${stem}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw badRequest(`无法生成不重名文件：${filename}`);
}

function isPathInside(file, root) {
  const normalizedFile = resolve(file);
  const normalizedRoot = resolve(root);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${pathSeparator()}`);
}

function pathSeparator() {
  return process.platform === "win32" ? "\\" : "/";
}

function sanitizeResourceFilename(value = "") {
  const filename = basename(String(value || "").trim());
  if (!filename || filename === "." || filename === "..") throw badRequest("文件名不安全。");
  return filename.replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

function getProviderStatus() {
  const activeProfile = getActiveProviderProfile();
  if (activeProfile) {
    return {
      ...sanitizeProviderProfile(activeProfile),
      source: "sqlite",
    };
  }

  const type = process.env.AGENT_PROVIDER || "openai-compatible";
  const baseUrl = process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL || "";
  const model = process.env.AGENT_MODEL || process.env.OPENAI_MODEL || "";
  return {
    type,
    name: "Environment Provider",
    baseUrl,
    model,
    hasApiKey: Boolean(process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
    keyPreview: previewSecret(process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || ""),
    source: "env",
  };
}

async function runTagGenerationPlanner({
  userRequest = "",
  currentPlan = null,
  providerOverride,
  modelContextOverride,
} = {}) {
  const provider = createConfiguredProvider(providerOverride);
  const modelContext = await withPromptTagToolContext(modelContextOverride || await buildModelContext(), buildPromptTagSearchText(userRequest, [], currentPlan));
  const plan = await withLowPerformanceProviderMemory(async () => provider.createGenerationPlan({
    userRequest,
    modelContext,
  }), providerOverride);
  const hintedPlan = applyRequestedResourceHints({ ...currentPlan, ...plan }, {
    userRequest,
    conversation: [],
    modelContext,
  });
  const preset = chooseQualityPreset({
    intent: userRequest,
    currentPlan,
    plan: hintedPlan,
    modelContext,
  });
  const normalizedPlan = normalizePlanForResponse(applyPromptTagToolToPlan(applyTagPlannerDefaults(hintedPlan, preset, modelContext), modelContext.promptTagTool));
  return {
    plan: normalizedPlan,
    compatibility: validatePlan(normalizedPlan),
    promptTagTool: compactPromptTagToolForResponse(modelContext.promptTagTool),
  };
}

async function withLowPerformanceProviderMemory(action, providerOverride = null) {
  const settings = getAppSettings();
  const activeProfile = getActiveProviderProfile();
  const providerConfig = providerOverride && Object.keys(providerOverride).length
    ? normalizeProviderInput(providerOverride, { partial: true })
    : activeProfile;
  const localModel = providerConfig?.type === "local" ? providerConfig.model : "";
  if (!settings.lowPerformanceMode || !localModel) return action();

  const events = [];
  try {
    events.push(await unloadImageModelSafe());
    const result = await action();
    if (result && typeof result === "object") {
      return {
        ...result,
        _lowPerformanceEvents: [
          ...(Array.isArray(result._lowPerformanceEvents) ? result._lowPerformanceEvents : []),
          ...events,
        ],
      };
    }
    return result;
  } finally {
    events.push(await stopLocalLlmModel(localModel));
  }
}

async function unloadImageModelSafe() {
  try {
    return await unloadA1111Model();
  } catch (error) {
    return {
      backend: getBackendName(),
      unloaded: false,
      error: error.message,
    };
  }
}

function buildReviseUserRequest({ currentPlan, conversation = [], userRequest = "" }) {
  return [
    "请基于 currentPlan 和 conversation 修改生图方案，只输出完整 JSON。",
    JSON.stringify({
      currentPlan,
      conversation,
      userRequest,
    }),
  ].join("\n");
}

function buildPromptTagSearchText(userRequest = "", conversation = [], currentPlan = null) {
  return [
    Array.isArray(conversation) ? conversation.slice(-6).map((item) => `${item.role || "user"}: ${item.text || item.content || ""}`).join("\n") : "",
    currentPlan?.positive_prompt || "",
    userRequest,
  ].filter(Boolean).join("\n");
}


function normalizeResourceLookupName(value = "") {
  return String(value || "").toLowerCase().replace(/\.(safetensors|ckpt|pt|pth)$/i, "").replace(/[_\s/\\[\]()-]+/g, "");
}

function chooseQualityPreset({
  intent = "",
  conversation = [],
  currentPlan = null,
  plan = null,
  modelContext = {},
  aspect,
  baseType,
  loraCount,
} = {}) {
  const text = [
    Array.isArray(conversation) ? conversation.map((item) => item.text || item.content || "").join("\n") : "",
    currentPlan?.positive_prompt || "",
    plan?.positive_prompt || "",
    intent,
  ].join("\n").toLowerCase();
  const explicitQuick = /快速|草图|预览|低耗时|省显存|quick|draft|preview/.test(text);
  const wantsPortrait = aspect === "portrait" || /手机壁纸|竖屏|竖幅|portrait|头像|半身|近景|海报|全身/.test(text);
  const wantsWallpaper = /手机壁纸|壁纸|1080|1920|4k|高清|大图/.test(text);
  const wantsFinal = /高清|精致|精修|成片|发布|高质量|细节|壁纸|头像|final|best quality|masterpiece/.test(text);
  const hasLora = Number(loraCount || 0) > 0 || (Array.isArray(plan?.lora) && plan.lora.length > 0) || /lora|shiratama|画风/.test(text);
  const resolvedAspect = aspect || (wantsPortrait ? "portrait" : /横屏|横幅|landscape|banner/.test(text) ? "landscape" : "square");
  const resolvedBaseType = baseType || inferBaseTypeFromPlanOrContext(plan || currentPlan, modelContext);
  const highQuality = !explicitQuick && (wantsFinal || wantsWallpaper || hasLora);
  const sd15Portrait = resolvedBaseType !== "sdxl" && resolvedBaseType !== "pony" && resolvedAspect === "portrait";

  return {
    id: explicitQuick ? "quick_preview" : highQuality ? "auto_high_quality" : "balanced",
    highQuality,
    explicitQuick,
    aspect: resolvedAspect,
    baseType: resolvedBaseType,
    size: sd15Portrait
      ? { width: 512, height: 768 }
      : resolvedBaseType === "sdxl" || resolvedBaseType === "pony"
        ? resolvedAspect === "portrait" ? { width: 832, height: 1216 } : resolvedAspect === "landscape" ? { width: 1216, height: 832 } : { width: 1024, height: 1024 }
        : resolvedAspect === "landscape" ? { width: 768, height: 512 } : { width: 512, height: 512 },
    target: null,
    refineTarget: null,
    steps: highQuality ? 28 : explicitQuick ? 10 : 18,
    cfg_scale: highQuality ? 6 : 5,
    samplerPriority: ["DPM++ 2M Karras", "DPM++ 2M", "DPM++ SDE Karras", "Euler a"],
    refine: false,
    upscale: false,
    adetailer: highQuality && (/头像|半身|近景|人物|少女|1girl|1boy|portrait|face|壁纸/.test(text) || hasLora),
    loraStyleWeight: highQuality ? 0.68 : 0.65,
  };
}

function inferBaseTypeFromPlanOrContext(plan = {}, modelContext = {}) {
  const checkpointName = plan?.checkpoint || "";
  const checkpoints = Array.isArray(modelContext.checkpoints) ? modelContext.checkpoints : [];
  const match = checkpoints.find((checkpoint) => normalizeResourceLookupName(checkpoint.title || checkpoint.name) === normalizeResourceLookupName(checkpointName)
    || normalizeResourceLookupName(checkpoint.title || checkpoint.name).includes(normalizeResourceLookupName(checkpointName))
    || normalizeResourceLookupName(checkpointName).includes(normalizeResourceLookupName(checkpoint.title || checkpoint.name)));
  return match?.profile?.baseType || "sd15";
}

function hasTriggerlessStyleLora(plan = {}) {
  return Array.isArray(plan.lora) && plan.lora.some((lora) => {
    if (!lora || typeof lora !== "object") return false;
    const triggers = Array.isArray(lora.trigger_words) ? lora.trigger_words.filter(Boolean) : [];
    const name = normalizeResourceLookupName(lora.name || lora.alias || "");
    return triggers.length === 0 && (name.includes("shiratama") || Number(lora.weight || 0) >= 0.5);
  });
}

function applyTagPlannerDefaults(plan = {}, preset = {}, modelContext = {}) {
  const next = forceSinglePassPlan(normalizeGenerationPlan(plan || {}));
  if (preset.size) {
    next.width = preset.size.width;
    next.height = preset.size.height;
  }
  if (preset.highQuality || preset.explicitQuick) {
    next.steps = preset.steps;
    next.cfg_scale = preset.cfg_scale;
  }
  next.sampler = chooseSampler(next.sampler, preset.samplerPriority, modelContext);
  next.lora = normalizePlannerLoras(next.lora, preset, { triggerlessStyleLora: hasTriggerlessStyleLora(next) });
  next.positive_prompt = simplifyPositivePrompt(next.positive_prompt, next.lora);
  next.negative_prompt = simplifyNegativePrompt(next.negative_prompt);
  next.rationale = [
    next.rationale || "",
    "已根据 prompt-all-in-one 标签库生成简洁 tags，并强制单次 txt2img：不使用 Hires、Extras、ADetailer 或视觉评级。",
  ].filter(Boolean).join("\n");
  return forceSinglePassPlan(next);
}

function simplifyPositivePrompt(value = "", loras = []) {
  const tags = splitPromptTags(value);
  const blockedTags = blockedPromptTagsForLoras(loras);
  const preferred = [
    "masterpiece",
    "best quality",
    "1girl",
    "solo",
    "simple background",
    "white background",
    "looking at viewer",
    "smile",
    "upper body",
    "portrait",
    "long hair",
    "white hair",
    "blue eyes",
    "clean lineart",
  ];
  const seen = new Set();
  const result = [];
  for (const tag of [...tags, ...preferred]) {
    const normalized = tag.toLowerCase();
    if (!tag || seen.has(normalized) || blockedTags.has(normalized)) continue;
    seen.add(normalized);
    result.push(tag);
    if (result.length >= 18) break;
  }
  return result.join(", ");
}

function blockedPromptTagsForLoras(loras = []) {
  const blocked = new Set();
  for (const lora of Array.isArray(loras) ? loras : []) {
    if (!lora || typeof lora !== "object") continue;
    const triggerWords = Array.isArray(lora.trigger_words) ? lora.trigger_words.filter(Boolean) : [];
    if (triggerWords.length) continue;
    for (const value of [lora.name, lora.alias, lora.filename, lora.model]) {
      const text = String(value || "").trim();
      if (!text) continue;
      const base = text.replace(/\.(safetensors|ckpt|pt|pth)$/i, "");
      for (const candidate of [text, base, base.replace(/[_-]+/g, " ")]) {
        if (candidate.trim()) blocked.add(candidate.trim().toLowerCase());
      }
    }
  }
  return blocked;
}

function simplifyNegativePrompt(value = "") {
  const defaults = [
    "low quality",
    "worst quality",
    "blurry",
    "bad anatomy",
    "bad hands",
    "extra fingers",
    "deformed face",
    "text",
    "watermark",
    "logo",
  ];
  const seen = new Set();
  return [...splitPromptTags(value), ...defaults]
    .filter((tag) => {
      const normalized = tag.toLowerCase();
      if (!tag || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, 14)
    .join(", ");
}

function chooseSampler(current = "", priority = [], modelContext = {}) {
  const samplers = Array.isArray(modelContext.samplers) ? modelContext.samplers.map((sampler) => sampler.name || sampler).filter(Boolean) : [];
  if (!samplers.length) return current || priority[0] || "Euler a";
  for (const wanted of priority || []) {
    const exact = samplers.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (exact) return exact;
    const loose = samplers.find((name) => name.toLowerCase().includes(wanted.toLowerCase().replace(/\s+karras\b/i, "")));
    if (loose) return loose;
  }
  return current && samplers.includes(current) ? current : samplers[0];
}

function normalizePlannerLoras(loras = [], preset = {}, options = {}) {
  if (!Array.isArray(loras)) return [];
  return loras.map((lora) => {
    if (!lora || typeof lora !== "object") return lora;
    const triggerWords = Array.isArray(lora.trigger_words)
      ? lora.trigger_words.filter((word) => isLikelyRealTriggerWord(word))
      : [];
    const rawWeight = Number.isFinite(Number(lora.weight)) ? Number(lora.weight) : preset.loraStyleWeight || 0.7;
    const isTriggerless = triggerWords.length === 0;
    const name = normalizeResourceLookupName(lora.name || lora.alias || "");
    const maxWeight = isTriggerless
      ? name.includes("shiratama") || options.triggerlessStyleLora ? 0.3 : 0.55
      : 0.85;
    const minWeight = isTriggerless && (name.includes("shiratama") || options.triggerlessStyleLora) ? 0.15 : 0.35;
    const weight = Math.max(minWeight, Math.min(maxWeight, rawWeight));
    return {
      ...lora,
      weight,
      trigger_words: triggerWords,
    };
  });
}

function applyRequestedResourceHints(plan = {}, { userRequest = "", conversation = [], modelContext = {} } = {}) {
  const next = normalizeGenerationPlan(plan || {});
  const requestedText = [
    Array.isArray(conversation) ? conversation.map((item) => item.text || item.content || "").join("\n") : "",
    userRequest,
  ].join("\n");
  const selectedNames = new Set((Array.isArray(next.lora) ? next.lora : [])
    .map((lora) => normalizeResourceLookupName(lora.name || lora.alias || lora.filename || ""))
    .filter(Boolean));
  const compatible = compatibleLorasForCheckpoint(next.checkpoint, listResourceProfiles());
  for (const lora of compatible) {
    if (!textMentionsResource(requestedText, lora)) continue;
    const normalizedName = normalizeResourceLookupName(lora.name);
    if (selectedNames.has(normalizedName)) continue;
    next.lora.push({
      name: lora.name,
      alias: lora.title,
      weight: Number(lora.defaultWeight || 0.7),
      trigger_words: (lora.triggerWords || []).filter((word) => isLikelyRealTriggerWord(word)),
    });
    selectedNames.add(normalizedName);
  }
  return next;
}

function textMentionsResource(text = "", resource = {}) {
  const normalizedText = normalizeResourceLookupName(text);
  return [resource.name, resource.title, resource.path]
    .map(normalizeResourceLookupName)
    .filter(Boolean)
    .some((value) => normalizedText.includes(value) || value.includes(normalizedText));
}

function isLikelyRealTriggerWord(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/[\u4e00-\u9fff]/.test(text)) return false;
  if (/\.(safetensors|ckpt|pt|pth)$/i.test(text)) return false;
  return true;
}

function preparePlanForGeneration(rawPlan = {}) {
  const plan = forceSinglePassPlan(normalizeGenerationPlan(rawPlan));
  const runtime = resolvePlanRuntimeResources(plan, listResourceProfiles());
  const sizedPlan = applyRuntimeSize(plan, runtime.size);
  return forceSinglePassPlan({
    ...sizedPlan,
    controlnet: runtime.controlnet || sizedPlan.controlnet || [],
    _runtime: {
      ...(plan._runtime || {}),
      checkpoint: runtime.checkpoint,
      vae: runtime.vae,
      compatibility: runtime.compatibility,
    },
  });
}

function validatePlan(plan = {}) {
  return validateGenerationPlanResources(normalizeGenerationPlan(plan), listResourceProfiles());
}

function normalizePlanForResponse(rawPlan = {}) {
  const plan = forceSinglePassPlan(normalizeGenerationPlan({
    ...rawPlan,
    checkpoint: rawPlan.checkpoint || getAppSettings().defaultCheckpoint || "",
  }));
  const compatibility = validatePlan(plan);
  return forceSinglePassPlan(applyRuntimeSize(plan, compatibility.recommendedSize?.[aspectBucketForPlan(plan)]));
}

function forceSinglePassPlan(plan = {}) {
  return {
    ...plan,
    target_width: null,
    target_height: null,
    hires_fix: false,
    refine: false,
    upscale: false,
    adetailer: false,
  };
}

function applyPromptTagToolToPlan(rawPlan = {}, promptTagTool = {}) {
  if (!promptTagTool?.ok || !Array.isArray(promptTagTool.candidates)) return rawPlan;
  const essentialTags = selectEssentialPromptTags(promptTagTool.candidates);
  if (!essentialTags.length) return rawPlan;
  const merged = mergePromptTags(rawPlan.positive_prompt, essentialTags);
  return {
    ...rawPlan,
    positive_prompt: merged.prompt,
    rationale: [
      rawPlan.rationale || "",
      merged.added.length ? `已根据 prompt-all-in-one 标签库补充关键 tags：${merged.added.join(", ")}。` : "",
    ].filter(Boolean).join("\n"),
  };
}

function selectEssentialPromptTags(candidates = []) {
  const byGroup = new Map();
  const selectedNames = new Set();
  for (const candidate of candidates) {
    if (!candidate?.name || Number(candidate.score || 0) < 80) continue;
    if (!isAtomicPromptTag(candidate.name)) continue;
    const normalizedName = candidate.name.toLowerCase();
    if (selectedNames.has(normalizedName)) continue;
    const groupKey = candidate.groupId || candidate.group || "other";
    const existing = byGroup.get(groupKey);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      byGroup.set(groupKey, candidate);
      selectedNames.add(normalizedName);
    }
  }
  return Array.from(byGroup.values())
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0))
    .slice(0, 10)
    .map((candidate) => candidate.name);
}

function isAtomicPromptTag(value = "") {
  const tag = String(value || "").trim();
  if (!tag || tag.length > 48) return false;
  if (tag.includes(",")) return false;
  if (/[(){}[\]<>]/.test(tag)) return false;
  return /^[a-zA-Z0-9_ -]+$/.test(tag);
}

function mergePromptTags(value = "", additions = []) {
  const existing = splitPromptTags(value);
  const seen = new Set(existing.map((tag) => tag.toLowerCase()));
  const added = [];
  for (const tag of additions) {
    const normalized = String(tag || "").trim();
    if (!normalized || seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    existing.push(normalized);
    added.push(normalized);
  }
  return { prompt: existing.join(", "), added };
}

function splitPromptTags(value = "") {
  return String(value || "")
    .replace(/\r?\n/g, ",")
    .replace(/[;；，、]+/g, ",")
    .split(",")
    .map((tag) => tag.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function applyRuntimeSize(plan = {}, size = {}) {
  const width = Number(size?.width || plan.width || 512);
  const height = Number(size?.height || plan.height || 512);
  const targetWidth = Number(plan.target_width || 0);
  const targetHeight = Number(plan.target_height || 0);
  const targetMatchesBase = targetWidth === width && targetHeight === height;
  return {
    ...plan,
    width,
    height,
    target_width: targetMatchesBase ? null : plan.target_width,
    target_height: targetMatchesBase ? null : plan.target_height,
  };
}

function aspectBucketForPlan(plan = {}) {
  const width = Number(plan.target_width || plan.width || 512);
  const height = Number(plan.target_height || plan.height || 512);
  const ratio = width / Math.max(1, height);
  if (ratio < 0.9) return "portrait";
  if (ratio > 1.1) return "landscape";
  return "square";
}

function ensureResourceProfilesFromModelContext(context = {}) {
  upsertResourceProfiles(profilesFromResources({
    a1111: {
      checkpoints: context.checkpoints || [],
      loras: context.loras || [],
      vaes: context.vaes || [],
      controlnet: context.controlnet || [],
    },
  }));
}

function ensureResourceProfilesFromResources(resources = {}) {
  upsertResourceProfiles(profilesFromResources(resources));
}

function buildResourceCompatibilitySummary(profiles = []) {
  return {
    total: profiles.length,
    pending: profiles.filter((profile) => profile.baseType === "unknown" && ["lora", "controlnet"].includes(profile.type)).length,
    checkpoints: profiles.filter((profile) => profile.type === "checkpoint").length,
    loras: profiles.filter((profile) => profile.type === "lora").length,
    vaes: profiles.filter((profile) => profile.type === "vae").length,
    controlnet: profiles.filter((profile) => profile.type === "controlnet").length,
  };
}

async function withPromptTagToolContext(modelContext = {}, userRequest = "") {
  const promptTagTool = await buildPromptTagToolContext(userRequest).catch((error) => ({
    tool: "prompt-all-in-one.tag_search",
    ok: false,
    error: error.message,
    candidates: [],
    groups: [],
  }));
  return {
    ...modelContext,
    promptTagTool,
  };
}

async function buildPromptTagToolContext(userRequest = "") {
  const root = process.env.SD_WEBUI_ROOT || findLikelyWebuiRoot();
  const tools = detectPromptTools(root);
  const promptAllInOne = tools.promptAllInOne;
  if (!promptAllInOne.installed || !promptAllInOne.groupTagsPath) {
    return {
      tool: "prompt-all-in-one.tag_search",
      ok: false,
      installed: false,
      candidates: [],
      groups: [],
      instruction: "Prompt tag library is unavailable; fall back to common SD tags.",
    };
  }

  const library = await loadPromptTagLibrary(promptAllInOne.groupTagsPath, "zh_CN");
  const terms = extractPromptTagSearchTerms(userRequest);
  const scored = scorePromptTags(library.tags, terms);
  const candidates = scored.slice(0, 80).map(({ tag, score }) => ({
    name: tag.name,
    translation: tag.translation,
    category: tag.category,
    group: tag.group,
    groupId: tag.groupId,
    score,
  }));
  const groups = summarizePromptTagGroups(candidates).slice(0, 12);
  const toolCall = {
    id: `prompt-tags-${shortHash(terms.join("|") || "empty")}`,
    type: "tool_call",
    name: "prompt-all-in-one.tag_search",
    arguments: {
      query: String(userRequest || ""),
      locale: "zh_CN",
      limit: 80,
    },
  };
  const toolResult = {
    id: toolCall.id,
    type: "tool_result",
    name: toolCall.name,
    output: {
      candidates,
      groups,
      totalLibraryTags: library.tags.length,
      source: "sd-webui-prompt-all-in-one/group_tags",
    },
  };

  return {
    tool: "prompt-all-in-one.tag_search",
    ok: true,
    installed: true,
    locale: library.locale,
    source: "sd-webui-prompt-all-in-one/group_tags",
    query: terms,
    totalLibraryTags: library.tags.length,
    candidates,
    groups,
    toolCall,
    toolResult,
    instruction: "Prefer candidates[].name when they match the user intent. Use only the English tag names in positive_prompt/negative_prompt, separated by ASCII commas.",
  };
}

function extractPromptTagSearchTerms(userRequest = "") {
  const text = String(userRequest || "").toLowerCase();
  const terms = new Set();
  const compact = text.replace(/[，。！？、；：,.!?;:()[\]{}"'`~|\\/]+/g, " ");
  for (const token of compact.split(/\s+/)) {
    const trimmed = token.trim();
    if (trimmed.length >= 2 && trimmed.length <= 48) terms.add(trimmed);
  }

  const phraseMap = [
    ["正装", ["正装", "suit", "formal", "business_suit", "formal_dress"]],
    ["西装", ["西装", "suit", "business_suit"]],
    ["礼服", ["礼服", "formal_dress", "evening_gown", "gown"]],
    ["燕尾服", ["燕尾服", "tuxedo"]],
    ["职场", ["职场", "office", "business_suit", "office lady"]],
    ["银发", ["银发", "silver hair"]],
    ["白发", ["白发", "white hair"]],
    ["黑发", ["黑发", "black hair"]],
    ["金发", ["金发", "blonde hair"]],
    ["长发", ["长发", "long hair"]],
    ["短发", ["短发", "short hair"]],
    ["蓝眼", ["蓝眼", "blue eyes"]],
    ["红眼", ["红眼", "red eyes"]],
    ["绿眼", ["绿眼", "green eyes"]],
    ["女", ["女孩", "1girl", "solo"]],
    ["少女", ["少女", "1girl", "solo"]],
    ["男", ["男孩", "1boy", "solo"]],
    ["雨", ["雨", "rain", "rainy", "rainy night"]],
    ["夜", ["夜晚", "night", "night sky"]],
    ["咖啡", ["咖啡", "cafe"]],
    ["室内", ["室内", "indoors"]],
    ["户外", ["户外", "outdoors"]],
    ["微笑", ["微笑", "smile"]],
    ["坐", ["坐", "sitting"]],
    ["站", ["站", "standing"]],
    ["全身", ["全身", "full body"]],
    ["半身", ["半身", "upper body"]],
    ["头像", ["头像", "portrait", "close-up"]],
    ["壁纸", ["壁纸", "wallpaper"]],
    ["高质量", ["masterpiece", "best quality", "high quality"]],
    ["精致", ["detailed", "highly detailed"]],
    ["低质量", ["low quality", "worst quality"]],
    ["畸形", ["bad anatomy", "deformed"]],
    ["水印", ["watermark", "text", "logo"]],
  ];

  for (const [needle, mappedTerms] of phraseMap) {
    if (!text.includes(needle.toLowerCase())) continue;
    for (const term of mappedTerms) terms.add(term.toLowerCase());
  }

  return Array.from(terms).slice(0, 40);
}

function scorePromptTags(tags = [], terms = []) {
  if (!terms.length) return [];
  const scored = [];
  for (const tag of tags) {
    let score = 0;
    for (const term of terms) {
      const normalizedTerm = String(term || "").toLowerCase();
      if (!normalizedTerm) continue;
      if (tag.name.toLowerCase() === normalizedTerm) score += 120;
      else if (tag.translation.toLowerCase() === normalizedTerm) score += 100;
      else if (tag.group.toLowerCase() === normalizedTerm || tag.category.toLowerCase() === normalizedTerm) score += 80;
      else if (tag.name.toLowerCase().includes(normalizedTerm)) score += 40;
      else if (tag.translation.toLowerCase().includes(normalizedTerm)) score += 35;
      else if (tag.group.toLowerCase().includes(normalizedTerm)) score += 28;
      else if (tag.searchText.includes(normalizedTerm)) score += 12;
    }
    if (score > 0) scored.push({ tag, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.tag.name.localeCompare(b.tag.name));
}

function summarizePromptTagGroups(candidates = []) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = candidate.groupId || candidate.group || "unknown";
    const current = groups.get(key) || {
      groupId: candidate.groupId,
      category: candidate.category,
      group: candidate.group,
      count: 0,
      tags: [],
    };
    current.count += 1;
    if (current.tags.length < 12) current.tags.push(candidate.name);
    groups.set(key, current);
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

function compactPromptTagToolForResponse(promptTagTool = {}) {
  if (!promptTagTool?.ok) return promptTagTool || null;
  return {
    tool: promptTagTool.tool,
    ok: promptTagTool.ok,
    query: promptTagTool.query,
    totalLibraryTags: promptTagTool.totalLibraryTags,
    candidates: (promptTagTool.candidates || []).slice(0, 20),
    groups: (promptTagTool.groups || []).slice(0, 8),
  };
}

function shortHash(value = "") {
  let hash = 0;
  for (const char of String(value)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeResourceProfilePatch(input = {}) {
  return {
    baseType: input.baseType,
    preferredVae: input.preferredVae,
    recommendedSize: input.recommendedSize,
    triggerWords: Array.isArray(input.triggerWords)
      ? input.triggerWords
      : String(input.triggerWords || "").split(",").map((item) => item.trim()).filter(Boolean),
    defaultWeight: input.defaultWeight,
    compatibleCheckpoints: Array.isArray(input.compatibleCheckpoints)
      ? input.compatibleCheckpoints
      : String(input.compatibleCheckpoints || "").split(",").map((item) => item.trim()).filter(Boolean),
    blockedCheckpoints: Array.isArray(input.blockedCheckpoints)
      ? input.blockedCheckpoints
      : String(input.blockedCheckpoints || "").split(",").map((item) => item.trim()).filter(Boolean),
    controlType: input.controlType,
    defaultPreprocessor: input.defaultPreprocessor,
    defaultModule: input.defaultModule,
    defaultControlWeight: input.defaultControlWeight,
    notes: input.notes,
    userConfirmed: true,
  };
}

function createConfiguredProvider(override) {
  if (override && Object.keys(override).length) {
    return createProvider(override);
  }
  return createProvider(profileToProviderConfig(getActiveProviderProfile()) || {});
}

async function testProvider() {
  const activeProfile = getActiveProviderProfile();
  const provider = createConfiguredProvider();
  const started = Date.now();
  const modelContext = await buildModelContext();
  const plan = await withLowPerformanceProviderMemory(async () => provider.createGenerationPlan({
    userRequest: `连接测试 ${randomUUID().slice(0, 8)}：生成一个极简头像方案。`,
    modelContext,
  }), activeProfile);
  return {
    ok: true,
    latencyMs: Date.now() - started,
    provider: getProviderStatus(),
    samplePlan: normalizePlanForResponse(plan),
  };
}

async function testProviderProfile(providerId) {
  const profile = getProviderProfile(providerId);
  if (!profile) return null;

  try {
    const provider = createProvider(profileToProviderConfig(profile));
    const modelContext = await buildModelContext();
    const plan = await withLowPerformanceProviderMemory(async () => provider.createGenerationPlan({
      userRequest: `连接测试 ${randomUUID().slice(0, 8)}：生成一个极简头像方案。`,
      modelContext,
    }), profile);
    return updateProviderTestStatus(providerId, {
      status: "ok",
      message: normalizePlanForResponse(plan).checkpoint || "Provider test succeeded.",
    });
  } catch (error) {
    return updateProviderTestStatus(providerId, {
      status: "failed",
      message: error.message,
    });
  }
}

function normalizeProviderInput(input = {}, { partial = false } = {}) {
  const output = {};
  if (!partial || Object.hasOwn(input, "id")) output.id = input.id;
  if (!partial || Object.hasOwn(input, "name")) output.name = String(input.name || "").trim() || localGemmaProvider.name;
  if (!partial || Object.hasOwn(input, "type")) output.type = normalizeProviderType(input.type);
  if (!partial || Object.hasOwn(input, "baseUrl")) output.baseUrl = trimTrailingSlash(input.baseUrl || input.base_url || "");
  if (!partial || Object.hasOwn(input, "model")) output.model = String(input.model || "").trim();
  if (Object.hasOwn(input, "apiKey")) output.apiKey = String(input.apiKey || "");
  if (Object.hasOwn(input, "isActive")) output.isActive = Boolean(input.isActive);
  return output;
}

function normalizeProviderType(type) {
  const value = String(type || "openai-compatible").trim();
  return ["openai", "openai-compatible", "local", "anthropic", "mock"].includes(value)
    ? value
    : "openai-compatible";
}

function sanitizeProviderProfile(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    type: profile.type,
    baseUrl: profile.baseUrl,
    model: profile.model,
    hasApiKey: profile.hasApiKey,
    keyPreview: profile.keyPreview,
    isActive: profile.isActive,
    testStatus: profile.testStatus,
    testMessage: profile.testMessage,
    testedAt: profile.testedAt,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

async function scanFiles(dir, allowedExtensions) {
  try {
    const entries = await readdir(dir);
    const files = [];
    for (const entry of entries) {
      const path = join(dir, entry);
      const itemStat = await stat(path);
      if (itemStat.isDirectory()) {
        files.push(...await scanFiles(path, allowedExtensions));
        continue;
      }
      if (!itemStat.isFile()) continue;
      if (!allowedExtensions.includes(extname(entry).toLowerCase())) continue;
      files.push({ name: entry, path, size: itemStat.size });
    }
    return files;
  } catch {
    return [];
  }
}

function findLikelyWebuiRoot() {
  return join(projectRoot, "vendor", "engines", "stable-diffusion-webui");
}

function detectPromptTools(webuiRoot) {
  const promptAllInOnePath = join(webuiRoot || "", "extensions", "sd-webui-prompt-all-in-one");
  const groupTagsPath = join(promptAllInOnePath, "group_tags");
  const installed = existsSync(promptAllInOnePath);
  return {
    promptAllInOne: {
      installed,
      path: installed ? promptAllInOnePath : "",
      groupTagsPath: existsSync(groupTagsPath) ? groupTagsPath : "",
      groupTagFiles: countFiles(groupTagsPath, [".yaml", ".yml"]),
      capabilities: ["comma_tag_prompt", "group_tags", "tag_formatting", "lora_trigger_highlight", "negative_prompt_groups"],
    },
  };
}

function countFiles(dir, extensions = []) {
  try {
    if (!existsSync(dir)) return 0;
    return readdirSync(dir)
      .filter((entry) => extensions.includes(extname(entry).toLowerCase()))
      .length;
  } catch {
    return 0;
  }
}

async function getPromptAllInOneTags({ query = "", locale = "zh_CN", groupId = "", limit = 180 } = {}) {
  const root = process.env.SD_WEBUI_ROOT || findLikelyWebuiRoot();
  const tools = detectPromptTools(root);
  const promptAllInOne = tools.promptAllInOne;
  if (!promptAllInOne.installed || !promptAllInOne.groupTagsPath) {
    return { promptAllInOne, categories: [], tags: [], totalTags: 0, query };
  }

  const library = await loadPromptTagLibrary(promptAllInOne.groupTagsPath, locale);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const normalizedGroupId = String(groupId || "").trim();
  const filtered = library.tags.filter((tag) => {
    if (normalizedGroupId && tag.groupId !== normalizedGroupId) return false;
    if (normalizedQuery && !tag.searchText.includes(normalizedQuery)) return false;
    return true;
  });
  const tags = filtered.slice(0, limit);

  return {
    promptAllInOne,
    locale: library.locale,
    sourceFile: library.sourceFile,
    categories: library.categories,
    tags: tags.map(({ searchText, ...tag }) => tag),
    totalTags: library.tags.length,
    totalMatched: filtered.length,
    query,
    groupId: normalizedGroupId,
  };
}

async function loadPromptTagLibrary(groupTagsPath, locale) {
  const sourceFile = resolvePromptTagFile(groupTagsPath, locale);
  const cacheKey = sourceFile;
  const cached = promptTagCache.get(cacheKey);
  if (cached) return cached;

  const text = await readFile(sourceFile, "utf8");
  const library = parsePromptTagYaml(text, { locale, sourceFile });
  promptTagCache.set(cacheKey, library);
  return library;
}

function resolvePromptTagFile(groupTagsPath, locale = "zh_CN") {
  const candidates = [
    "custom.yaml",
    `${locale}.yaml`,
    "zh_CN.yaml",
    "default.yaml",
  ];
  for (const filename of candidates) {
    const file = join(groupTagsPath, filename);
    if (existsSync(file)) return file;
  }
  return join(groupTagsPath, "default.yaml");
}

function parsePromptTagYaml(text, { locale = "zh_CN", sourceFile = "" } = {}) {
  const categories = [];
  const tags = [];
  let currentCategory = null;
  let currentGroup = null;
  let inTags = false;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed.startsWith("- name:")) {
      currentCategory = {
        id: slugifyTagCategory(valueAfterColon(trimmed)),
        name: valueAfterColon(trimmed),
        groups: [],
      };
      categories.push(currentCategory);
      currentGroup = null;
      inTags = false;
      continue;
    }

    if (indent === 4 && trimmed.startsWith("- name:") && currentCategory) {
      currentGroup = {
        id: `${currentCategory.id}-${slugifyTagCategory(valueAfterColon(trimmed))}`,
        name: valueAfterColon(trimmed),
        color: "",
        count: 0,
      };
      currentCategory.groups.push(currentGroup);
      inTags = false;
      continue;
    }

    if (indent === 6 && trimmed.startsWith("color:") && currentGroup) {
      currentGroup.color = valueAfterColon(trimmed);
      continue;
    }

    if (indent === 6 && trimmed === "tags:" && currentCategory && currentGroup) {
      inTags = true;
      continue;
    }

    if (inTags && indent >= 8 && currentCategory && currentGroup) {
      const tag = parsePromptTagLine(trimmed);
      if (!tag.name) continue;
      currentGroup.count += 1;
      tags.push({
        name: tag.name,
        translation: tag.translation,
        category: currentCategory.name,
        categoryId: currentCategory.id,
        group: currentGroup.name,
        groupId: currentGroup.id,
        color: currentGroup.color,
        searchText: `${tag.name} ${tag.translation} ${currentCategory.name} ${currentGroup.name}`.toLowerCase(),
      });
    }
  }

  return {
    locale,
    sourceFile,
    categories,
    tags,
  };
}

function parsePromptTagLine(trimmed) {
  const normalized = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
  const colonIndex = normalized.indexOf(":");
  if (colonIndex < 0) return { name: stripYamlQuotes(normalized), translation: "" };
  return {
    name: stripYamlQuotes(normalized.slice(0, colonIndex)),
    translation: stripYamlQuotes(normalized.slice(colonIndex + 1)),
  };
}

function valueAfterColon(line) {
  return stripYamlQuotes(String(line || "").slice(String(line || "").indexOf(":") + 1));
}

function stripYamlQuotes(value) {
  const trimmed = String(value || "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function slugifyTagCategory(value) {
  return String(value || "group")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "group";
}

function createMockLoraPlan(projectName) {
  return {
    project_name: projectName,
    trigger_word: projectName.toLowerCase().replaceAll(" ", "_"),
    base_model: "animagineXL40_v4Opt.safetensors",
    resolution: 768,
    repeats: 10,
    epochs: 12,
    batch_size: 2,
    learning_rate: "1e-4",
    network_dim: 32,
    network_alpha: 16,
    optimizer: "AdamW8bit",
    caption_strategy: "wd14 + llm cleanup",
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function previewSecret(value) {
  if (!value) return "";
  if (value.length <= 10) return "***";
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

function sendJson(res, status, payload) {
  sendCors(res, status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendCors(res, status, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...headers,
  });
}

async function sendOutputImageFile(req, res, pathname, rootDir) {
  const filename = basename(decodeURIComponent(pathname));
  const file = join(rootDir, filename);
  const extension = extname(file).toLowerCase();

  if (!file.startsWith(rootDir) || ![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  try {
    await stat(file);
  } catch {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  sendCors(res, 200, {
    "Content-Type": imageContentType(extension),
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

async function saveControlNetReferenceImage(input = {}) {
  const image = String(input.image || input.dataUrl || "").trim();
  const parsed = parseDataImage(image);
  if (!parsed) {
    const error = new Error("ControlNet reference image must be a data:image URL");
    error.code = "BAD_REQUEST";
    throw error;
  }
  if (parsed.buffer.length > 20 * 1024 * 1024) {
    const error = new Error("ControlNet reference image is too large; max 20MB");
    error.code = "BAD_REQUEST";
    throw error;
  }
  mkdirSync(controlNetReferenceDir, { recursive: true });
  const cleanName = sanitizeUploadName(input.filename || "reference");
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${cleanName}.${parsed.extension}`;
  const file = join(controlNetReferenceDir, filename);
  await writeFile(file, parsed.buffer);
  return {
    filename,
    url: `/outputs/controlnet/${filename}`,
    size: parsed.buffer.length,
    mimeType: parsed.mimeType,
  };
}

function parseDataImage(value = "") {
  const match = String(value).match(/^data:(image\/(?:png|jpe?g|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return null;
  const mimeType = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
  return {
    mimeType,
    extension,
    buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

function sanitizeUploadName(value = "") {
  const extensionless = basename(String(value || "reference")).replace(/\.[^.]+$/, "");
  return (extensionless || "reference")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "reference";
}

function imageContentType(extension = "") {
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  return "image/png";
}

async function openGenerationInFileManager(generation) {
  const firstImage = generation.images?.find((image) => image.filename)?.filename || "";
  const target = firstImage ? resolve(generationOutputDir, basename(firstImage)) : generationOutputDir;
  const safeTarget = target.startsWith(generationOutputDir) ? target : generationOutputDir;
  const exists = existsSync(safeTarget);
  const command = fileManagerCommand(exists ? safeTarget : generationOutputDir);
  if (!command) {
    const error = new Error("Open in file manager is supported on macOS, Windows, and Linux desktop environments.");
    error.code = "UNSUPPORTED_PLATFORM";
    throw error;
  }
  await execFilePromise(command.command, command.args);
  return {
    ok: true,
    path: safeTarget,
    opened: exists ? "file" : "folder",
  };
}

function fileManagerCommand(target) {
  if (process.platform === "darwin") return { command: "open", args: ["-R", target] };
  if (process.platform === "win32") return { command: "explorer.exe", args: ["/select,", target] };
  if (process.platform === "linux") return { command: "xdg-open", args: [dirname(target)] };
  return null;
}

function execFilePromise(command, args = []) {
  return new Promise((resolveExec, rejectExec) => {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) rejectExec(error);
      else resolveExec();
    });
  });
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
