import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProvider } from "@sd-agent-studio/model-providers";
import { normalizeGenerationPlan } from "@sd-agent-studio/shared";
import { loadEnvFile } from "./env.js";
import {
  deleteGeneration,
  getGeneration,
  listGenerations,
  listResourceIndex,
  updateResourcePurpose,
  upsertResources,
} from "./db.js";
import { getBackendName, getEngineModels, getEngineStatus } from "./engines.js";
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

if (process.argv.includes("--check")) {
  console.log("backend scaffold ok");
  process.exit(0);
}

restoreInterruptedTasks();

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    sendJson(res, 500, {
      error: {
        message: error.message,
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
      comfyuiBaseUrl: process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188",
      provider: providerStatus.type,
      providerStatus,
      engines: engineStatus.engines,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/plan") {
    const body = await readJson(req);
    const provider = createProvider(body.provider || {});
    const plan = await provider.createGenerationPlan({
      userRequest: body.userRequest || "",
      modelContext: body.modelContext || await buildModelContext(),
    });
    sendJson(res, 200, { plan: normalizeGenerationPlan(plan) });
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
    const provider = createProvider(body.provider || {});
    const plan = await provider.createGenerationPlan({
      userRequest,
      modelContext: body.modelContext || await buildModelContext(),
    });
    sendJson(res, 200, { plan: normalizeGenerationPlan({ ...currentPlan, ...plan }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate/run") {
    const body = await readJson(req);
    const task = createGenerationTask({
      plan: normalizeGenerationPlan(body.plan || {}),
      backend: body.backend || getBackendName(),
    });
    sendJson(res, 202, { task, taskId: task.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/generate") {
    const body = await readJson(req);
    const task = createGenerationTask({
      plan: normalizeGenerationPlan(body.plan || {}),
      backend: body.backend || getBackendName(),
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
    const task = action === "cancel" ? await cancelGenerationTask(taskId) : retryGenerationTask(taskId);
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

  if (req.method === "POST" && url.pathname === "/api/providers/test") {
    sendJson(res, 200, await testProvider());
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/providers/config") {
    sendJson(res, 501, { error: { message: "Provider config editing is reserved for the desktop settings flow. Edit local .env for now." } });
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

  return {
    webuiRoot: root,
    checkpoints: a1111Checkpoints.length ? a1111Checkpoints : await scan("models/Stable-diffusion", [".safetensors", ".ckpt"]),
    loras: a1111Models.loras?.length ? a1111Models.loras : await scan("models/Lora", [".safetensors", ".pt"]),
    vaes: a1111Models.vaes?.length ? a1111Models.vaes : await scan("models/VAE", [".safetensors", ".ckpt", ".pt"]),
    controlnet: a1111Models.controlnet?.length ? a1111Models.controlnet : await scan("models/ControlNet", [".safetensors", ".pth", ".pt"]),
    samplers: a1111Models.samplers || [],
  };
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
    resources.index = listResourceIndex();
  }

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
  const type = process.env.AGENT_PROVIDER || "mock/openai-compatible";
  const baseUrl = process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL || "";
  const model = process.env.AGENT_MODEL || process.env.OPENAI_MODEL || "";
  return {
    type,
    baseUrl,
    model,
    hasApiKey: Boolean(process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY),
    keyPreview: previewSecret(process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || ""),
  };
}

async function testProvider() {
  const provider = createProvider();
  const started = Date.now();
  const plan = await provider.createGenerationPlan({
    userRequest: `连接测试 ${randomUUID().slice(0, 8)}：生成一个极简头像方案。`,
    modelContext: await buildModelContext(),
  });
  return {
    ok: true,
    latencyMs: Date.now() - started,
    provider: getProviderStatus(),
    samplePlan: normalizeGenerationPlan(plan),
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
