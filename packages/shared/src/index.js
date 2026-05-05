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
    width: 832,
    height: 1216,
    sampler: "DPM++ 2M Karras",
    steps: 28,
    cfg_scale: 6.5,
    seed: -1,
    batch_size: 4,
    hires_fix: true,
    adetailer: true,
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
  normalized.width = clampInteger(normalized.width, 256, 2048, 832);
  normalized.height = clampInteger(normalized.height, 256, 2048, 1216);
  normalized.steps = clampInteger(normalized.steps, 1, 80, 28);
  normalized.cfg_scale = clampNumber(normalized.cfg_scale, 1, 20, 6.5);
  normalized.batch_size = clampInteger(normalized.batch_size, 1, 16, 4);
  normalized.seed = Number.isFinite(Number(normalized.seed)) ? Number(normalized.seed) : -1;
  normalized.lora = Array.isArray(normalized.lora) ? normalized.lora : [];
  normalized.controlnet = Array.isArray(normalized.controlnet) ? normalized.controlnet : [];
  return normalized;
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

