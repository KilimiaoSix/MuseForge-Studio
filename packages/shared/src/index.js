export const TaskTypes = Object.freeze({
  TXT2IMG: "txt2img",
  IMG2IMG: "img2img",
  INPAINT: "inpaint",
  UPSCALE: "upscale",
  LORA_TRAINING: "lora_training",
});

export const ProviderTypes = Object.freeze({
  OPENAI: "openai",
  OPENAI_COMPATIBLE: "openai-compatible",
  LOCAL: "local",
  ANTHROPIC: "anthropic",
  MOCK: "mock",
});

export const defaultNegativePrompt = [
  "bad hands",
  "extra fingers",
  "low quality",
  "blurry",
  "watermark",
  "text",
  "logo",
  "deformed face",
].join(", ");

export function createGenerationPlan(overrides = {}) {
  return {
    task_type: TaskTypes.TXT2IMG,
    positive_prompt: "",
    negative_prompt: defaultNegativePrompt,
    checkpoint: "",
    lora: [],
    controlnet: [],
    width: 512,
    height: 512,
    target_width: null,
    target_height: null,
    sampler: "Euler a",
    steps: 8,
    cfg_scale: 5,
    seed: -1,
    batch_size: 1,
    hires_fix: false,
    refine: false,
    upscale: false,
    adetailer: false,
    rationale: "",
    ...overrides,
  };
}

export function createEditPlan(overrides = {}) {
  return {
    task_type: TaskTypes.INPAINT,
    preserve: [],
    modify: [],
    denoise_strength: 0.45,
    controlnet: "",
    positive_prompt: "",
    negative_prompt: defaultNegativePrompt,
    rationale: "",
    ...overrides,
  };
}

export function createLoraTrainingPlan(overrides = {}) {
  return {
    project_name: "",
    trigger_word: "",
    base_model: "",
    resolution: 768,
    repeats: 10,
    epochs: 12,
    batch_size: 2,
    learning_rate: "1e-4",
    network_dim: 32,
    network_alpha: 16,
    optimizer: "AdamW8bit",
    caption_strategy: "wd14 + llm cleanup",
    ...overrides,
  };
}

export function normalizeGenerationPlan(plan = {}) {
  const normalized = createGenerationPlan(plan);
  if (![TaskTypes.TXT2IMG, TaskTypes.IMG2IMG, TaskTypes.INPAINT, TaskTypes.UPSCALE].includes(normalized.task_type)) {
    normalized.task_type = TaskTypes.TXT2IMG;
  }
  const requestedWidth = clampInteger(normalized.width, 256, 2048, 512);
  const requestedHeight = clampInteger(normalized.height, 256, 2048, 512);
  const baseSize = recommendedBaseSize(requestedWidth, requestedHeight);
  normalized.width = baseSize.width;
  normalized.height = baseSize.height;
  normalized.target_width = optionalInteger(normalized.target_width, 256, 4096);
  normalized.target_height = optionalInteger(normalized.target_height, 256, 4096);
  if ((!normalized.target_width || !normalized.target_height) && (requestedWidth !== baseSize.width || requestedHeight !== baseSize.height)) {
    normalized.target_width = requestedWidth;
    normalized.target_height = requestedHeight;
  }
  if (normalized.target_width === normalized.width && normalized.target_height === normalized.height) {
    normalized.target_width = null;
    normalized.target_height = null;
  }
  normalized.steps = clampInteger(normalized.steps, 1, 80, 8);
  normalized.cfg_scale = clampNumber(normalized.cfg_scale, 1, 20, 5);
  normalized.batch_size = clampInteger(normalized.batch_size, 1, 16, 1);
  normalized.seed = Number.isFinite(Number(normalized.seed)) ? Number(normalized.seed) : -1;
  normalized.lora = normalizeLoras(normalized.lora);
  normalized.controlnet = Array.isArray(normalized.controlnet) ? normalized.controlnet : [];
  normalized.refine = normalizeRefine(normalized);
  normalized.upscale = normalizeUpscale(normalized);
  normalized.hires_fix = normalizeHiresFix(normalized);
  return normalized;
}

export function normalizeHiresFix(plan = {}) {
  if (plan.refine && typeof plan.refine === "object" && plan.refine.enabled) {
    return {
      enabled: true,
      mode: "hires",
      target_width: plan.refine.target_width,
      target_height: plan.refine.target_height,
      denoising_strength: plan.refine.denoising_strength,
      upscaler: plan.refine.upscaler,
      second_pass_steps: plan.refine.second_pass_steps,
    };
  }

  const baseWidth = clampInteger(plan.width, 256, 2048, 512);
  const baseHeight = clampInteger(plan.height, 256, 2048, 512);
  const targetWidth = optionalInteger(plan.target_width ?? plan.hires_fix?.target_width, 256, 4096);
  const targetHeight = optionalInteger(plan.target_height ?? plan.hires_fix?.target_height, 256, 4096);
  const targetDiffers = Boolean(targetWidth && targetHeight && (targetWidth !== baseWidth || targetHeight !== baseHeight));
  const source = typeof plan.hires_fix === "object" && plan.hires_fix ? plan.hires_fix : {};
  const enabled = targetDiffers && (plan.hires_fix === true || (source.enabled === true && source.mode !== "resize"));

  if (!enabled) return false;

  return {
    enabled: true,
    mode: source.mode || "hires",
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: clampNumber(source.denoising_strength, 0, 1, 0.2),
    upscaler: source.upscaler || "Lanczos",
    second_pass_steps: clampInteger(source.second_pass_steps, 1, 80, Math.max(10, Math.round(clampInteger(plan.steps, 1, 80, 8) * 0.6))),
  };
}

export function normalizeRefine(plan = {}) {
  const baseWidth = clampInteger(plan.width, 256, 2048, 512);
  const baseHeight = clampInteger(plan.height, 256, 2048, 512);
  const source = typeof plan.refine === "object" && plan.refine
    ? plan.refine
    : typeof plan.hires_fix === "object" && plan.hires_fix && plan.hires_fix.mode !== "resize"
      ? plan.hires_fix
      : {};
  const explicitlyEnabled = plan.refine === true || plan.hires_fix === true || source.enabled === true;
  const targetWidth = optionalInteger(source.target_width ?? plan.refine_width, 256, 4096);
  const targetHeight = optionalInteger(source.target_height ?? plan.refine_height, 256, 4096);
  const targetDiffers = Boolean(targetWidth && targetHeight && (targetWidth !== baseWidth || targetHeight !== baseHeight));

  if (!explicitlyEnabled || !targetDiffers) return false;

  return {
    enabled: true,
    target_width: targetWidth,
    target_height: targetHeight,
    denoising_strength: clampNumber(source.denoising_strength, 0, 1, 0.25),
    upscaler: source.upscaler || "Latent",
    second_pass_steps: clampInteger(source.second_pass_steps, 1, 80, Math.max(10, Math.round(clampInteger(plan.steps, 1, 80, 8) * 0.55))),
  };
}

export function normalizeUpscale(plan = {}) {
  const source = typeof plan.upscale === "object" && plan.upscale ? plan.upscale : {};
  const baseWidth = clampInteger(plan.width, 256, 2048, 512);
  const baseHeight = clampInteger(plan.height, 256, 2048, 512);
  const refineWidth = optionalInteger(plan.refine?.target_width ?? plan.hires_fix?.target_width, 256, 4096);
  const refineHeight = optionalInteger(plan.refine?.target_height ?? plan.hires_fix?.target_height, 256, 4096);
  const sourceWidth = refineWidth || baseWidth;
  const sourceHeight = refineHeight || baseHeight;
  const targetWidth = optionalInteger(source.target_width ?? plan.target_width, 256, 4096);
  const targetHeight = optionalInteger(source.target_height ?? plan.target_height, 256, 4096);
  const targetDiffers = Boolean(targetWidth && targetHeight && (targetWidth !== sourceWidth || targetHeight !== sourceHeight));
  const explicitlyDisabled = plan.upscale === false || source.enabled === false;
  const explicitlyEnabled = source.enabled === true;

  if (explicitlyDisabled || !targetDiffers && !explicitlyEnabled) return false;
  if (!targetWidth || !targetHeight) return false;

  return {
    enabled: true,
    target_width: targetWidth,
    target_height: targetHeight,
    upscaler: source.upscaler || "Lanczos",
    resize_mode: source.resize_mode || "fit",
  };
}

export function recommendedBaseSize(width = 512, height = 512) {
  const safeWidth = clampInteger(width, 256, 2048, 512);
  const safeHeight = clampInteger(height, 256, 2048, 512);
  const ratio = safeWidth / safeHeight;
  if (ratio < 0.9) return { width: 512, height: 768 };
  if (ratio > 1.1) return { width: 768, height: 512 };
  return { width: 512, height: 512 };
}

export function normalizeLoras(loras = []) {
  if (!Array.isArray(loras)) return [];
  return loras
    .map((lora) => {
      if (typeof lora === "string") {
        return { name: lora, weight: 1, trigger_words: [] };
      }
      if (!lora || typeof lora !== "object") return null;
      const name = String(lora.name || lora.alias || lora.model || lora.filename || "").trim();
      if (!name) return null;
      const weight = clampNumber(lora.weight ?? lora.strength ?? 1, -2, 2, 1);
      const triggerWords = Array.isArray(lora.trigger_words)
        ? lora.trigger_words.filter(Boolean).map(String)
        : String(lora.trigger_words || lora.trigger || "").split(",").map((item) => item.trim()).filter(Boolean);
      return { ...lora, name, weight, trigger_words: triggerWords };
    })
    .filter(Boolean);
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function optionalInteger(value, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
