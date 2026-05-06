import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "@sd-agent-studio/model-providers";
import { normalizeGenerationPlan } from "@sd-agent-studio/shared";
import { loadEnvFile } from "./env.js";
import {
  deleteGeneration,
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
  updateResourceProfile,
  updateResourcePurpose,
  upsertResourceProfiles,
  upsertResources,
} from "./db.js";
import { getBackendName, getEngineModels, getEngineStatus } from "./engines.js";
import { deleteLocalLlmModel, getLocalLlmPullTask, getLocalLlmStatus, listLocalLlmPullTasks, localGemmaProvider, pullGemmaModel, pullLocalLlmModel, searchOllamaLibrary, getOllamaModelInfo } from "./local-llm.js";
import {
  compactModelContextForPlanning,
  profilesFromResources,
  resolvePlanRuntimeResources,
  validateGenerationPlanResources,
} from "./resource-compat.js";
import {
  cancelGenerationTask,
  createGenerationTask,
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
const promptTagCache = new Map();
if (process.argv.includes("--check")) {
  console.log("backend scaffold ok");
  process.exit(0);
}

restoreInterruptedTasks();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(res, error.code === "RESOURCE_COMPATIBILITY_ERROR" ? 400 : 500, {
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
    await sendGenerationFile(req, res, url.pathname);
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
    const provider = createConfiguredProvider(body.provider);
    const modelContext = await withPromptTagToolContext(body.modelContext || await buildModelContext(), body.userRequest || "");
    const plan = await provider.createGenerationPlan({
      userRequest: body.userRequest || "",
      modelContext,
    });
    const normalizedPlan = normalizePlanForResponse(applyPromptTagToolToPlan(plan, modelContext.promptTagTool));
    sendJson(res, 200, { plan: normalizedPlan, compatibility: validatePlan(normalizedPlan), promptTagTool: compactPromptTagToolForResponse(modelContext.promptTagTool) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/revise") {
    const body = await readJson(req);
    const currentPlan = normalizeGenerationPlan(body.plan || {});
    const userRequest = [
      "请基于 currentPlan 和 conversation 修改生图方案，只输出完整 JSON。",
      JSON.stringify({
        currentPlan,
        conversation: body.conversation || [],
        userRequest: body.userRequest || "",
      }),
    ].join("\n");
    const provider = createConfiguredProvider(body.provider);
    const modelContext = await withPromptTagToolContext(body.modelContext || await buildModelContext(), userRequest);
    const plan = await provider.createGenerationPlan({
      userRequest,
      modelContext,
    });
    const normalizedPlan = normalizePlanForResponse(applyPromptTagToolToPlan({ ...currentPlan, ...plan }, modelContext.promptTagTool));
    sendJson(res, 200, { plan: normalizedPlan, compatibility: validatePlan(normalizedPlan), promptTagTool: compactPromptTagToolForResponse(modelContext.promptTagTool) });
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

  const generationMatch = url.pathname.match(/^\/api\/generations\/([^/]+)$/);
  if (req.method === "GET" && generationMatch) {
    const generation = getGeneration(generationMatch[1]);
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

  if (req.method === "POST" && url.pathname === "/api/lora/plan") {
    const body = await readJson(req);
    sendJson(res, 200, {
      plan: createMockLoraPlan(body.projectName || "new_lora"),
      note: "This is a scaffold response. Connect kohya_ss or sd-scripts in the next implementation pass.",
    });
    return;
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
    checkpoints: a1111Checkpoints.length ? a1111Checkpoints : await scan("models/Stable-diffusion", [".safetensors", ".ckpt"]),
    loras: a1111Models.loras?.length ? a1111Models.loras : await scan("models/Lora", [".safetensors", ".pt"]),
    vaes: a1111Models.vaes?.length ? a1111Models.vaes : await scan("models/VAE", [".safetensors", ".ckpt", ".pt"]),
    controlnet: a1111Models.controlnet?.length ? a1111Models.controlnet : await scan("models/ControlNet", [".safetensors", ".pth", ".pt"]),
    samplers: a1111Models.samplers || [],
    promptTools: engineModels?.engines?.a1111?.promptTools || detectPromptTools(root),
  };
  ensureResourceProfilesFromModelContext(context);
  return compactModelContextForPlanning(context, listResourceProfiles());
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
      controlnet: models.controlnet || [],
      options: models.options || {},
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
    resources.index = listResourceIndex();
  }

  ensureResourceProfilesFromResources(resources);
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

function preparePlanForGeneration(rawPlan = {}) {
  const plan = normalizeGenerationPlan(rawPlan);
  const runtime = resolvePlanRuntimeResources(plan, listResourceProfiles());
  const sizedPlan = applyRuntimeSize(plan, runtime.size);
  return {
    ...sizedPlan,
    _runtime: {
      ...(plan._runtime || {}),
      checkpoint: runtime.checkpoint,
      vae: runtime.vae,
      compatibility: runtime.compatibility,
    },
  };
}

function validatePlan(plan = {}) {
  return validateGenerationPlanResources(normalizeGenerationPlan(plan), listResourceProfiles());
}

function normalizePlanForResponse(rawPlan = {}) {
  const plan = normalizeGenerationPlan(rawPlan);
  const compatibility = validatePlan(plan);
  return applyRuntimeSize(plan, compatibility.recommendedSize?.[aspectBucketForPlan(plan)]);
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
    toolCalls: [
      ...(Array.isArray(modelContext.toolCalls) ? modelContext.toolCalls : []),
      promptTagTool.toolCall,
    ].filter(Boolean),
    toolResults: [
      ...(Array.isArray(modelContext.toolResults) ? modelContext.toolResults : []),
      promptTagTool.toolResult,
    ].filter(Boolean),
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
    toolCall: promptTagTool.toolCall,
    toolResult: promptTagTool.toolResult ? {
      ...promptTagTool.toolResult,
      output: {
        ...promptTagTool.toolResult.output,
        candidates: (promptTagTool.toolResult.output?.candidates || []).slice(0, 20),
        groups: (promptTagTool.toolResult.output?.groups || []).slice(0, 8),
      },
    } : undefined,
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
  const plan = await provider.createGenerationPlan({
    userRequest: `连接测试 ${randomUUID().slice(0, 8)}：生成一个极简头像方案。`,
    modelContext: await buildModelContext(),
  });
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
    const plan = await provider.createGenerationPlan({
      userRequest: `连接测试 ${randomUUID().slice(0, 8)}：生成一个极简头像方案。`,
      modelContext: await buildModelContext(),
    });
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

async function sendGenerationFile(req, res, pathname) {
  const filename = basename(decodeURIComponent(pathname));
  const file = join(generationOutputDir, filename);

  if (!file.startsWith(generationOutputDir) || extname(file).toLowerCase() !== ".png") {
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
    "Content-Type": "image/png",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
