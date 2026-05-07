import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeGenerationPlan } from "@sd-agent-studio/shared";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const manifestPath = join(projectRoot, "engines", "manifest.json");
const generationOutputDir = join(projectRoot, "outputs", "generations");
const controlNetReferenceDir = join(projectRoot, "outputs", "controlnet");

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
  const engine = manifest.engines.a1111;
  const path = resolveWebuiRoot(manifest, engine);
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

export async function runGeneration(plan, options = {}) {
  return runA1111Txt2Img(plan, options);
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

export async function runA1111Txt2Img(plan, options = {}) {
  const normalizedPlan = normalizeSinglePassPlan(plan || {});
  const baseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");
  const checkpoint = normalizedPlan._runtime?.checkpoint || normalizedPlan.checkpoint || "";
  const vae = normalizedPlan._runtime?.vae || "Automatic";
  const controlNetArgs = await buildA1111ControlNetArgs(normalizedPlan);
  const pipelineStages = [{
    id: "base",
    label: "单次出图",
    status: "pending",
    params: {
      width: normalizedPlan.width,
      height: normalizedPlan.height,
      steps: normalizedPlan.steps,
      sampler: normalizedPlan.sampler,
    },
  }];
  const markStage = (id, patch) => {
    const stage = pipelineStages.find((item) => item.id === id);
    if (stage) Object.assign(stage, patch);
    if (typeof options.onProgress === "function") {
      options.onProgress({
        pipelineStages,
        progressLabel: patch.progressLabel || stage?.label || "",
        progress: patch.progress,
      });
    }
  };

  markStage("base", { status: "running", progress: 0.08, progressLabel: "基础构图中" });
  const payload = {
    prompt: buildA1111Prompt(normalizedPlan),
    negative_prompt: normalizedPlan.negative_prompt,
    width: normalizedPlan.width,
    height: normalizedPlan.height,
    sampler_name: normalizedPlan.sampler,
    steps: normalizedPlan.steps,
    cfg_scale: normalizedPlan.cfg_scale,
    seed: normalizedPlan.seed,
    batch_size: normalizedPlan.batch_size,
    override_settings: {
      ...(checkpoint ? { sd_model_checkpoint: checkpoint, sd_vae: vae } : {}),
      ...(plan._runtime?.clipSkip || plan.clip_skip ? { CLIP_stop_at_last_layers: Math.max(1, Math.round(finiteNumber(plan._runtime?.clipSkip || plan.clip_skip, 1))) } : {}),
    },
    override_settings_restore_afterwards: false,
    enable_hr: false,
    alwayson_scripts: controlNetArgs.length ? {
      controlnet: {
        args: controlNetArgs,
      },
    } : undefined,
  };

  const data = await postA1111JsonWithRecovery(baseUrl, "/sdapi/v1/txt2img", payload, "txt2img");
  markStage("base", { status: "succeeded", progress: 0.95, progressLabel: "单次出图完成" });
  const outputImages = await saveA1111Images(data.images || [], normalizedPlan, {
    stage: "base",
  });

  return {
    backend: InferenceBackends.A1111,
    baseUrl,
    ...data,
    warnings: [
      ...(Array.isArray(data.warnings) ? data.warnings : []),
    ].filter(Boolean),
    pipelineStages,
    intermediateImages: [],
    outputImages,
  };
}

function normalizeSinglePassPlan(plan = {}) {
  const normalized = normalizeGenerationPlan({
    ...plan,
    target_width: null,
    target_height: null,
    hires_fix: false,
    refine: false,
    upscale: false,
  });
  normalized.target_width = null;
  normalized.target_height = null;
  normalized.hires_fix = false;
  normalized.refine = false;
  normalized.upscale = false;
  return normalized;
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

async function buildA1111ControlNetArgs(plan = {}) {
  const units = [];
  for (const control of Array.isArray(plan.controlnet) ? plan.controlnet : []) {
    const unit = await normalizeControlNetUnit(control);
    if (unit) units.push(unit);
  }
  return units;
}

async function normalizeControlNetUnit(control = {}) {
  if (!control) return null;
  const name = typeof control === "string" ? control : control.name || control.model || control.filename || "";
  if (!name) return null;
  if (typeof control === "string") {
    throw new Error(`ControlNet ${name} requires a reference image.`);
  }
  const imageSource = control.image || control.input_image || control.reference_image || "";
  if (!String(imageSource || "").trim()) {
    throw new Error(`ControlNet ${name} requires a reference image.`);
  }
  const image = typeof control === "object"
    ? await resolveControlNetImage(imageSource)
    : "";
  if (!image) throw new Error(`ControlNet ${name} reference image is empty.`);

  const module = control.module || control.preprocessor || "none";
  const model = control.extensionName || control.model || name;
  return {
    enabled: control.enabled !== false,
    image,
    module,
    preprocessor: module,
    model,
    weight: finiteNumber(control.weight ?? control.control_weight, 1),
    resize_mode: control.resize_mode || "Scale to Fit (Inner Fit)",
    lowvram: Boolean(control.lowvram || control.low_vram),
    processor_res: Math.round(finiteNumber(control.processor_res, 512)),
    threshold_a: finiteNumber(control.threshold_a, 64),
    threshold_b: finiteNumber(control.threshold_b, 64),
    guidance_start: finiteNumber(control.guidance_start, 0),
    guidance_end: finiteNumber(control.guidance_end, 1),
    control_mode: control.control_mode || "Balanced",
    pixel_perfect: control.pixel_perfect !== false,
    save_detected_map: Boolean(control.save_detected_map),
  };
}

async function resolveControlNetImage(value = "") {
  const source = String(value || "").trim();
  if (!source) return "";
  if (source.startsWith("data:")) return stripDataUrlPrefix(source);
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`ControlNet reference image fetch failed: ${response.status} ${source}`);
    return Buffer.from(await response.arrayBuffer()).toString("base64");
  }
  if (source.startsWith("/outputs/generations/")) {
    const filename = decodeURIComponent(source.split("/").pop() || "");
    if (!filename) return "";
    return (await readFile(join(generationOutputDir, filename))).toString("base64");
  }
  if (source.startsWith("/outputs/controlnet/")) {
    const filename = decodeURIComponent(source.split("/").pop() || "");
    if (!filename) return "";
    return (await readFile(join(controlNetReferenceDir, filename))).toString("base64");
  }
  if (existsSync(source)) {
    return (await readFile(source)).toString("base64");
  }
  return stripDataUrlPrefix(source);
}

function formatWeight(value) {
  return String(Math.round(Number(value) * 100) / 100);
}

async function postA1111JsonWithRecovery(baseUrl, path, payload, action, options = {}) {
  const first = await postA1111Json(baseUrl, path, payload);
  if (first.ok) return first.data;
  const recovered = typeof options.onFailure === "function" ? await options.onFailure(first) : null;
  if (recovered) return recovered;
  if (!isA1111RecoverableDeviceError(first.body)) {
    throw new Error(formatA1111Error(action, first));
  }

  await recoverA1111DeviceState(baseUrl);
  const retry = await postA1111Json(baseUrl, path, payload);
  if (retry.ok) return retry.data;
  const retryRecovered = typeof options.onFailure === "function" ? await options.onFailure(retry) : null;
  if (retryRecovered) return retryRecovered;

  const message = isA1111RecoverableDeviceError(retry.body)
    ? `${formatA1111Error(action, retry)}. 已尝试自动重载 checkpoint 但仍失败。若你在 macOS Apple Silicon 上使用 MPS，请通过 scripts/start-a1111.sh 重启 A1111，确保 PYTORCH_ENABLE_MPS_FALLBACK=1 已生效；也可以临时关闭 ControlNet、LoRA 或降低基础分辨率后再试。`
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

function isA1111RecoverableDeviceError(body = "") {
  return /Expected all tensors to be on the same device/i.test(body)
    || /at least two devices,\s*cpu and cuda/i.test(body)
    || /Placeholder storage has not been allocated on MPS device/i.test(body);
}

function formatA1111Error(action, response) {
  return `A1111 ${action} failed: ${response.status} ${response.body}`;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeModelLookupKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(safetensors|ckpt|pt|pth)$/g, "")
    .replace(/\[[a-f0-9]{6,}\]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

async function saveA1111Images(images, plan, metadata = {}) {
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
      stage: metadata.stage || "",
    });
  }

  return saved;
}

async function getA1111Models() {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines.a1111;
  const path = resolveWebuiRoot(manifest, engine);
  const baseUrl = resolveEngineBaseUrl(engine);
  const [apiModels, apiLoras, apiSamplers, apiUpscalers, apiOptions, controlnet] = await Promise.all([
    fetchJson(`${baseUrl}/sdapi/v1/sd-models`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/loras`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/samplers`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/upscalers`).catch(() => null),
    fetchJson(`${baseUrl}/sdapi/v1/options`).catch(() => null),
    getA1111ControlNetCatalog(baseUrl).catch((error) => ({ installed: false, error: error.message, models: [], modules: [] })),
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
    controlnet: mergeControlNetModels(filesystemControlnet, controlnet.models),
    controlnetExtension: controlnet,
    samplers: Array.isArray(apiSamplers) ? apiSamplers.map((sampler) => ({ name: sampler.name, aliases: sampler.aliases || [], source: "api" })) : [],
    upscalers: Array.isArray(apiUpscalers) ? apiUpscalers.map((upscaler) => ({ name: upscaler.name, modelName: upscaler.model_name, modelPath: upscaler.model_path, source: "api" })) : [],
    options: apiOptions ? {
      sdModelCheckpoint: apiOptions.sd_model_checkpoint,
      sdVae: apiOptions.sd_vae,
    } : {},
  };
}

async function getA1111ControlNetCatalog(baseUrl) {
  const [models, modules] = await Promise.all([
    fetchJson(`${baseUrl}/controlnet/model_list`).catch(() => null),
    fetchJson(`${baseUrl}/controlnet/module_list`).catch(() => null),
  ]);
  const modelList = Array.isArray(models?.model_list) ? models.model_list : [];
  const moduleList = Array.isArray(modules?.module_list) ? modules.module_list : [];
  return {
    installed: Boolean(models || modules),
    models: modelList,
    modules: moduleList,
  };
}

function mergeControlNetModels(filesystemModels = [], extensionModels = []) {
  const byName = new Map();
  for (const model of filesystemModels) {
    if (!model?.name) continue;
    byName.set(model.name, { ...model, source: model.source || "filesystem" });
  }
  for (const name of extensionModels) {
    const key = String(name || "").trim();
    if (!key) continue;
    const normalized = normalizeModelLookupKey(key);
    const filesystemMatch = [...byName.values()].find((item) => normalizeModelLookupKey(item.name) === normalized || normalizeModelLookupKey(item.name).includes(normalized) || normalized.includes(normalizeModelLookupKey(item.name)));
    if (filesystemMatch) {
      byName.set(filesystemMatch.name, { ...filesystemMatch, model: key, extensionName: key, source: "api+filesystem" });
    } else {
      byName.set(key, { name: key, title: key, model: key, extensionName: key, source: "api" });
    }
  }
  return [...byName.values()];
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
      if (itemStat.isDirectory()) {
        files.push(...await scanFiles(path, allowedExtensions));
        continue;
      }
      if (!itemStat.isFile()) continue;
      if (!allowedExtensions.includes(extname(entry).toLowerCase())) continue;
      files.push({ name: entry, path, size: itemStat.size, source: "filesystem" });
    }
    return files;
  } catch {
    return [];
  }
}

function resolveWebuiRoot(manifest = {}, engine = {}) {
  if (process.env.SD_WEBUI_ROOT) return resolve(process.env.SD_WEBUI_ROOT);
  const installRoot = resolve(projectRoot, manifest.installDir || "vendor/engines");
  return join(installRoot, engine.directory || "stable-diffusion-webui");
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
