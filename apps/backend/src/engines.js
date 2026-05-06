import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(projectRoot, "engines", "manifest.json");
const generationOutputDir = join(projectRoot, "outputs", "generations");

export const InferenceBackends = Object.freeze({
  A1111: "a1111",
});

export async function loadEngineManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

export function getBackendName() {
  return InferenceBackends.A1111;
}

export async function getEngineStatus() {
  const manifest = await loadEngineManifest();
  const installRoot = resolve(projectRoot, manifest.installDir);
  const engine = manifest.engines.a1111;
  const path = join(installRoot, engine.directory);
  const baseUrl = resolveEngineBaseUrl(engine);
  const healthUrl = `${baseUrl}${engine.healthPath}`;
  const health = await testHttp(healthUrl);

  return {
    defaultBackend: InferenceBackends.A1111,
    engines: {
      a1111: {
        name: engine.name,
        installed: existsSync(path),
        path,
        port: engine.port,
        baseUrl,
        healthPath: engine.healthPath,
        running: health.ok,
        health,
        modelDirs: mapModelDirs(path, engine.modelDirs),
        promptTools: detectPromptTools(path),
      },
    },
  };
}

export async function getEngineModels() {
  const [status, a1111Models] = await Promise.all([
    getEngineStatus(),
    getA1111Models().catch((error) => ({ error: error.message, checkpoints: [] })),
  ]);

  return {
    defaultBackend: InferenceBackends.A1111,
    engines: {
      a1111: {
        ...status.engines.a1111,
        models: a1111Models,
      },
    },
  };
}

export async function runGeneration(plan) {
  return runA1111Txt2Img(plan);
}

export async function unloadA1111Model() {
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  const response = await fetch(`${baseUrl}/sdapi/v1/unload-checkpoint`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`A1111 model unload failed: ${response.status} ${await response.text()}`);
  }

  return { backend: InferenceBackends.A1111, unloaded: true };
}

export async function reloadA1111Model() {
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  await disableA1111KeepCheckpointInCpu(baseUrl).catch(() => {});
  const response = await fetch(`${baseUrl}/sdapi/v1/reload-checkpoint`, {
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(`A1111 model reload failed: ${response.status} ${await response.text()}`);
  }

  return { backend: InferenceBackends.A1111, reloaded: true };
}

export async function getGenerationProgress() {
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  const data = await fetchJson(`${baseUrl}/sdapi/v1/progress?skip_current_image=false`);
  return {
    backend: InferenceBackends.A1111,
    baseUrl,
    progress: Number(data.progress || 0),
    etaRelative: data.eta_relative ?? null,
    state: data.state || {},
    currentImage: data.current_image ? `data:image/png;base64,${stripDataUrlPrefix(data.current_image)}` : "",
  };
}

export async function interruptGeneration() {
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  const response = await fetch(`${baseUrl}/sdapi/v1/interrupt`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`A1111 interrupt failed: ${response.status} ${await response.text()}`);
  }
  return { backend: InferenceBackends.A1111, cancelled: true };
}

export async function runA1111Txt2Img(plan) {
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  const hiresFix = resolveA1111HiresFix(plan);
  const enableHighRes = hiresFix.enabled;
  const resizeTarget = resolveA1111ResizeTarget(plan);
  const checkpoint = plan._runtime?.checkpoint || plan.checkpoint || "";
  const vae = plan._runtime?.vae || "Automatic";
  const payload = {
    prompt: buildA1111Prompt(plan),
    negative_prompt: plan.negative_prompt,
    width: plan.width,
    height: plan.height,
    sampler_name: plan.sampler,
    steps: plan.steps,
    cfg_scale: plan.cfg_scale,
    seed: plan.seed,
    batch_size: plan.batch_size,
    override_settings: checkpoint ? { sd_model_checkpoint: checkpoint, sd_vae: vae } : undefined,
    override_settings_restore_afterwards: false,
    enable_hr: enableHighRes,
    denoising_strength: enableHighRes ? hiresFix.denoising_strength : undefined,
    hr_resize_x: enableHighRes ? hiresFix.target_width : undefined,
    hr_resize_y: enableHighRes ? hiresFix.target_height : undefined,
    hr_upscaler: enableHighRes ? hiresFix.upscaler : undefined,
    hr_second_pass_steps: enableHighRes ? hiresFix.second_pass_steps : undefined,
  };

  const data = await postA1111JsonWithRecovery(baseUrl, "/sdapi/v1/txt2img", payload, "txt2img");
  const images = !enableHighRes && resizeTarget.enabled
    ? await resizeA1111Images(baseUrl, data.images || [], resizeTarget)
    : data.images || [];
  const outputImages = await saveA1111Images(images, resizeTarget.enabled || enableHighRes ? {
    ...plan,
    target_width: resizeTarget.target_width || hiresFix.target_width,
    target_height: resizeTarget.target_height || hiresFix.target_height,
  } : plan);

  return {
    backend: InferenceBackends.A1111,
    baseUrl,
    ...data,
    outputImages,
  };
}

function buildA1111Prompt(plan = {}) {
  const prompt = String(plan.positive_prompt || "").trim();
  const triggerWords = (Array.isArray(plan.lora) ? plan.lora : [])
    .flatMap((lora) => Array.isArray(lora?.trigger_words) ? lora.trigger_words : [])
    .map((word) => String(word || "").trim())
    .filter(Boolean);
  const loraTags = (Array.isArray(plan.lora) ? plan.lora : [])
    .map((lora) => {
      const name = loraNameForPrompt(lora);
      if (!name) return "";
      const weight = finiteNumber(typeof lora === "object" ? lora.weight ?? lora.strength : 1, 1);
      return `<lora:${name}:${formatWeight(weight)}>`;
    })
    .filter(Boolean);
  return [prompt, ...triggerWords, ...loraTags].filter(Boolean).join(", ");
}

function loraNameForPrompt(lora) {
  const raw = typeof lora === "string" ? lora : lora?.name || lora?.alias || lora?.model || lora?.filename || "";
  return String(raw)
    .trim()
    .replace(/\.(safetensors|ckpt|pt)$/i, "");
}

function formatWeight(value) {
  return String(Math.round(Number(value) * 100) / 100);
}

function resolveA1111HiresFix(plan = {}) {
  const source = typeof plan.hires_fix === "object" && plan.hires_fix ? plan.hires_fix : {};
  const explicitlyEnabled = plan.hires_fix === true || (source.enabled === true && source.mode !== "resize");
  const width = Number(plan.width || 512);
  const height = Number(plan.height || 512);
  const targetWidth = Number(plan.target_width || source.target_width || 0);
  const targetHeight = Number(plan.target_height || source.target_height || 0);
  const targetDiffers = targetWidth > 0 && targetHeight > 0 && (targetWidth !== width || targetHeight !== height);

  if (!explicitlyEnabled || !targetDiffers) {
    return { enabled: false };
  }

  return {
    enabled: true,
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: finiteNumber(source.denoising_strength, 0.2),
    upscaler: source.upscaler || "Lanczos",
    second_pass_steps: Math.max(10, Math.round(finiteNumber(source.second_pass_steps, Math.round(Number(plan.steps || 8) * 0.6)))),
  };
}

function resolveA1111ResizeTarget(plan = {}) {
  const width = Number(plan.width || 512);
  const height = Number(plan.height || 512);
  const targetWidth = Number(plan.target_width || plan.hires_fix?.target_width || 0);
  const targetHeight = Number(plan.target_height || plan.hires_fix?.target_height || 0);
  const targetDiffers = targetWidth > 0 && targetHeight > 0 && (targetWidth !== width || targetHeight !== height);
  return {
    enabled: targetDiffers,
    target_width: targetDiffers ? targetWidth : 0,
    target_height: targetDiffers ? targetHeight : 0,
  };
}

async function resizeA1111Images(baseUrl, images, target) {
  const resized = [];
  for (const image of images) {
    const data = await postA1111JsonWithRecovery(baseUrl, "/sdapi/v1/extra-single-image", {
      resize_mode: 1,
      show_extras_results: true,
      gfpgan_visibility: 0,
      codeformer_visibility: 0,
      codeformer_weight: 0,
      upscaling_resize: 1,
      upscaling_resize_w: target.target_width,
      upscaling_resize_h: target.target_height,
      upscaling_crop: false,
      upscaler_1: "Lanczos",
      upscaler_2: "None",
      extras_upscaler_2_visibility: 0,
      upscale_first: false,
      image: stripDataUrlPrefix(image),
    }, "resize");
    resized.push(data.image || image);
  }
  return resized;
}

async function postA1111JsonWithRecovery(baseUrl, path, payload, action) {
  const first = await postA1111Json(baseUrl, path, payload);
  if (first.ok) return first.data;
  if (!isA1111DeviceMismatchError(first.body)) {
    throw new Error(formatA1111Error(action, first));
  }

  await recoverA1111DeviceState(baseUrl);
  const retry = await postA1111Json(baseUrl, path, payload);
  if (retry.ok) return retry.data;

  const message = isA1111DeviceMismatchError(retry.body)
    ? `${formatA1111Error(action, retry)}. 已尝试自动重载 checkpoint 但仍失败，请在 A1111 中重新加载模型或重启 WebUI。`
    : formatA1111Error(action, retry);
  throw new Error(message);
}

async function postA1111Json(baseUrl, path, payload) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, body };
  }
  return { ok: true, status: response.status, body, data: body ? JSON.parse(body) : {} };
}

async function recoverA1111DeviceState(baseUrl) {
  await disableA1111KeepCheckpointInCpu(baseUrl).catch(() => {});
  const response = await fetch(`${baseUrl}/sdapi/v1/reload-checkpoint`, { method: "POST" });
  if (!response.ok) {
    throw new Error(`A1111 自动恢复失败: ${response.status} ${await response.text()}`);
  }
}

async function disableA1111KeepCheckpointInCpu(baseUrl) {
  await fetch(`${baseUrl}/sdapi/v1/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sd_checkpoints_keep_in_cpu: false }),
  });
}

function isA1111DeviceMismatchError(body = "") {
  return /Expected all tensors to be on the same device/i.test(body)
    || /at least two devices,\s*cpu and cuda/i.test(body);
}

function formatA1111Error(action, response) {
  return `A1111 ${action} failed: ${response.status} ${response.body}`;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function saveA1111Images(images, plan) {
  if (!Array.isArray(images) || images.length === 0) return [];

  await mkdir(generationOutputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const id = randomUUID().slice(0, 8);
  const saved = [];

  for (const [index, image] of images.entries()) {
    const base64 = stripDataUrlPrefix(image);
    const filename = `${timestamp}-${id}-${index + 1}.png`;
    await writeFile(join(generationOutputDir, filename), Buffer.from(base64, "base64"));
    saved.push({
      url: `/outputs/generations/${filename}`,
      filename,
      width: plan.target_width || plan.hires_fix?.target_width || plan.width,
      height: plan.target_height || plan.hires_fix?.target_height || plan.height,
    });
  }

  return saved;
}

async function getA1111Models() {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines.a1111;
  const path = join(resolve(projectRoot, manifest.installDir), engine.directory);
  const baseUrl = resolveEngineBaseUrl(engine);
  const [apiModels, apiLoras, apiSamplers, apiOptions] = await Promise.all([
    fetchJson(`${baseUrl}/sdapi/v1/sd-models`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/loras`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/samplers`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/options`).catch(() => null),
  ]);
  const filesystemModels = await scanFiles(join(path, engine.modelDirs.checkpoints), [".safetensors", ".ckpt"]);
  const filesystemLoras = await scanFiles(join(path, engine.modelDirs.loras), [".safetensors", ".pt"]);
  const filesystemVaes = await scanFiles(join(path, engine.modelDirs.vae), [".safetensors", ".ckpt", ".pt"]);
  const filesystemControlnet = await scanFiles(join(path, engine.modelDirs.controlnet), [".safetensors", ".pth", ".pt"]);

  return {
    checkpoints: Array.isArray(apiModels)
      ? apiModels.map((model) => ({ name: model.model_name || model.title, title: model.title, filename: model.filename, source: "api" }))
      : filesystemModels,
    loras: Array.isArray(apiLoras)
      ? apiLoras.map((model) => ({ name: model.name || model.alias, alias: model.alias, path: model.path, source: "api" }))
      : filesystemLoras,
    vaes: filesystemVaes,
    controlnet: filesystemControlnet,
    samplers: Array.isArray(apiSamplers) ? apiSamplers.map((sampler) => ({ name: sampler.name, aliases: sampler.aliases || [], source: "api" })) : [],
    options: apiOptions ? {
      sdModelCheckpoint: apiOptions.sd_model_checkpoint,
      sdVae: apiOptions.sd_vae,
    } : {},
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

function detectPromptTools(webuiRoot) {
  const promptAllInOnePath = join(webuiRoot, "extensions", "sd-webui-prompt-all-in-one");
  const groupTagsPath = join(promptAllInOnePath, "group_tags");
  const installed = existsSync(promptAllInOnePath);
  return {
    promptAllInOne: {
      installed,
      path: installed ? promptAllInOnePath : "",
      groupTagsPath: existsSync(groupTagsPath) ? groupTagsPath : "",
      groupTagFiles: countFiles(groupTagsPath, [".yaml", ".yml"]),
      capabilities: [
        "comma_tag_prompt",
        "group_tags",
        "tag_formatting",
        "lora_trigger_highlight",
        "negative_prompt_groups",
      ],
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

function resolveEngineBaseUrl(engine) {
  return trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || engine.baseUrl);
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function stripDataUrlPrefix(value) {
  return String(value || "").replace(/^data:image\/\w+;base64,/, "");
}
