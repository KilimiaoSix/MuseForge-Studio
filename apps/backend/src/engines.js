import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(projectRoot, "engines", "manifest.json");

export const InferenceBackends = Object.freeze({
  COMFYUI: "comfyui",
  A1111: "a1111",
});

export async function loadEngineManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export function getBackendName(value = process.env.INFERENCE_BACKEND) {
  const backend = String(value || InferenceBackends.COMFYUI).toLowerCase();
  return backend === InferenceBackends.A1111 ? InferenceBackends.A1111 : InferenceBackends.COMFYUI;
}

export async function getEngineStatus() {
  const manifest = await loadEngineManifest();
  const installRoot = resolve(projectRoot, manifest.installDir);
  const engines = {};

  for (const key of Object.keys(manifest.engines)) {
    const engine = manifest.engines[key];
    const path = join(installRoot, engine.directory);
    const baseUrl = resolveEngineBaseUrl(key, engine);
    const healthUrl = `${baseUrl}${engine.healthPath}`;
    const health = await testHttp(healthUrl);

    engines[key] = {
      name: engine.name,
      installed: existsSync(path),
      path,
      port: engine.port,
      baseUrl,
      healthPath: engine.healthPath,
      running: health.ok,
      health,
      modelDirs: mapModelDirs(path, engine.modelDirs),
    };
  }

  return {
    defaultBackend: getBackendName(),
    engines,
  };
}

export async function getEngineModels() {
  const [status, comfyModels, a1111Models] = await Promise.all([
    getEngineStatus(),
    getComfyUiModels().catch((error) => ({ error: error.message, checkpoints: [] })),
    getA1111Models().catch((error) => ({ error: error.message, checkpoints: [] })),
  ]);

  return {
    defaultBackend: getBackendName(),
    engines: {
      comfyui: {
        ...status.engines.comfyui,
        models: comfyModels,
      },
      a1111: {
        ...status.engines.a1111,
        models: a1111Models,
      },
    },
  };
}

export async function runGeneration(plan, backend = getBackendName()) {
  if (backend === InferenceBackends.A1111) {
    return runA1111Txt2Img(plan);
  }

  return runComfyUiTxt2Img(plan);
}

export async function runA1111Txt2Img(plan) {
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  const payload = {
    prompt: plan.positive_prompt,
    negative_prompt: plan.negative_prompt,
    width: plan.width,
    height: plan.height,
    sampler_name: plan.sampler,
    steps: plan.steps,
    cfg_scale: plan.cfg_scale,
    seed: plan.seed,
    batch_size: plan.batch_size,
    override_settings: plan.checkpoint ? { sd_model_checkpoint: plan.checkpoint } : undefined,
    enable_hr: Boolean(plan.hires_fix),
  };

  const response = await fetch(`${baseUrl}/sdapi/v1/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`A1111 txt2img failed: ${response.status} ${await response.text()}`);
  }

  return {
    backend: InferenceBackends.A1111,
    baseUrl,
    ...(await response.json()),
  };
}

export async function runComfyUiTxt2Img(plan) {
  const baseUrl = trimTrailingSlash(process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188");
  const checkpoint = await resolveComfyCheckpoint(plan);
  const workflow = buildComfyTxt2ImgWorkflow({ ...plan, checkpoint });
  const clientId = randomUUID();

  const promptResponse = await fetch(`${baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });

  if (!promptResponse.ok) {
    throw new Error(`ComfyUI prompt submit failed: ${promptResponse.status} ${await promptResponse.text()}`);
  }

  const promptResult = await promptResponse.json();
  const promptId = promptResult.prompt_id;
  const history = await waitForComfyHistory(baseUrl, promptId);

  return {
    backend: InferenceBackends.COMFYUI,
    baseUrl,
    prompt_id: promptId,
    workflow,
    images: extractComfyImages(baseUrl, history[promptId]),
    history: history[promptId],
  };
}

export function buildComfyTxt2ImgWorkflow(plan) {
  const checkpoint = plan.checkpoint || "model.safetensors";
  const seed = Number(plan.seed) >= 0 ? Number(plan.seed) : Math.floor(Math.random() * 2147483647);
  const batchSize = Math.max(1, Number(plan.batch_size || 1));

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: {
        ckpt_name: checkpoint,
      },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: plan.positive_prompt,
        clip: ["1", 1],
      },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: {
        text: plan.negative_prompt,
        clip: ["1", 1],
      },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: plan.width,
        height: plan.height,
        batch_size: batchSize,
      },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: plan.steps,
        cfg: plan.cfg_scale,
        sampler_name: mapComfySampler(plan.sampler),
        scheduler: "normal",
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: {
        samples: ["5", 0],
        vae: ["1", 2],
      },
    },
    "7": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "sd_agent_studio",
        images: ["6", 0],
      },
    },
  };
}

async function resolveComfyCheckpoint(plan) {
  if (plan.checkpoint) return plan.checkpoint;

  const models = await getComfyUiModels().catch(() => ({ checkpoints: [] }));
  const first = models.checkpoints?.[0]?.name;
  if (!first) {
    throw new Error("ComfyUI checkpoint not found. Put a .safetensors or .ckpt file in ComfyUI/models/checkpoints, or set plan.checkpoint.");
  }
  return first;
}

async function waitForComfyHistory(baseUrl, promptId) {
  const timeoutMs = Number(process.env.COMFYUI_TIMEOUT_MS || 300000);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const response = await fetch(`${baseUrl}/history/${promptId}`);
    if (response.ok) {
      const history = await response.json();
      if (history[promptId]) return history;
    }
    await sleep(1000);
  }

  throw new Error(`ComfyUI generation timed out after ${timeoutMs}ms`);
}

function extractComfyImages(baseUrl, promptHistory) {
  const outputs = promptHistory?.outputs || {};
  const images = [];

  for (const output of Object.values(outputs)) {
    for (const image of output.images || []) {
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || "",
        type: image.type || "output",
      });
      images.push({
        filename: image.filename,
        subfolder: image.subfolder || "",
        type: image.type || "output",
        url: `${baseUrl}/view?${params.toString()}`,
      });
    }
  }

  return images;
}

async function getComfyUiModels() {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines.comfyui;
  const path = join(resolve(projectRoot, manifest.installDir), engine.directory);
  const baseUrl = resolveEngineBaseUrl("comfyui", engine);
  const objectInfo = await fetchJson(`${baseUrl}/object_info`).catch(() => null);
  const loader = objectInfo?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
  const filesystemModels = await scanFiles(join(path, engine.modelDirs.checkpoints), [".safetensors", ".ckpt"]);

  return {
    checkpoints: loader.length ? loader.map((name) => ({ name, source: "object_info" })) : filesystemModels,
  };
}

async function getA1111Models() {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines.a1111;
  const path = join(resolve(projectRoot, manifest.installDir), engine.directory);
  const baseUrl = resolveEngineBaseUrl("a1111", engine);
  const apiModels = await fetchJson(`${baseUrl}/sdapi/v1/sd-models`).catch(() => null);
  const filesystemModels = await scanFiles(join(path, engine.modelDirs.checkpoints), [".safetensors", ".ckpt"]);

  return {
    checkpoints: Array.isArray(apiModels)
      ? apiModels.map((model) => ({ name: model.model_name || model.title, title: model.title, source: "api" }))
      : filesystemModels,
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
  return response.json();
}

async function testHttp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return { ok: response.ok, status: response.status, url };
  } catch (error) {
    return { ok: false, error: error.message, url };
  }
}

function mapModelDirs(enginePath, dirs) {
  const result = {};
  for (const [key, relativePath] of Object.entries(dirs || {})) {
    result[key] = join(enginePath, relativePath);
  }
  return result;
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
      files.push({ name: entry, path, size: itemStat.size, source: "filesystem" });
    }
    return files;
  } catch {
    return [];
  }
}

function resolveEngineBaseUrl(key, engine) {
  if (key === "comfyui") return trimTrailingSlash(process.env.COMFYUI_BASE_URL || engine.baseUrl);
  if (key === "a1111") return trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || engine.baseUrl);
  return trimTrailingSlash(engine.baseUrl);
}

function mapComfySampler(sampler = "") {
  const value = sampler.toLowerCase();
  if (value.includes("euler a")) return "euler_ancestral";
  if (value.includes("euler")) return "euler";
  if (value.includes("dpm++ 2m")) return "dpmpp_2m";
  if (value.includes("dpm++ sde")) return "dpmpp_sde";
  if (value.includes("ddim")) return "ddim";
  return "dpmpp_2m";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
