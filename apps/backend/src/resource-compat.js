export const ResourceTypes = Object.freeze({
  CHECKPOINT: "checkpoint",
  LORA: "lora",
  VAE: "vae",
  CONTROLNET: "controlnet",
  SAMPLER: "sampler",
});

export const BaseTypes = Object.freeze({
  SD15: "sd15",
  SDXL: "sdxl",
  PONY: "pony",
  FLUX: "flux",
  UNIVERSAL: "universal",
  UNKNOWN: "unknown",
});

export function profileFromResource(type, item = {}) {
  const name = resourceName(item);
  const baseType = inferBaseType(type, item);
  return {
    type,
    name,
    title: item.title || item.alias || item.name || "",
    path: item.path || item.filename || "",
    source: item.source || "",
    baseType,
    preferredVae: type === ResourceTypes.CHECKPOINT ? defaultVaeForBaseType(baseType) : "",
    recommendedSize: type === ResourceTypes.CHECKPOINT ? recommendedSizeForBaseType(baseType) : {},
    triggerWords: type === ResourceTypes.LORA ? inferTriggerWords(item) : [],
    defaultWeight: type === ResourceTypes.LORA ? 0.75 : 0,
    compatibleCheckpoints: [],
    blockedCheckpoints: [],
    controlType: type === ResourceTypes.CONTROLNET ? inferControlType(item) : "",
    defaultPreprocessor: "",
    defaultModule: "",
    defaultControlWeight: type === ResourceTypes.CONTROLNET ? 1 : 0,
    notes: "",
  };
}

export function profilesFromResources(resources = {}) {
  const a1111 = resources.a1111 || resources;
  return [
    ...asArray(a1111.checkpoints).map((item) => profileFromResource(ResourceTypes.CHECKPOINT, item)),
    ...asArray(a1111.loras).map((item) => profileFromResource(ResourceTypes.LORA, item)),
    ...asArray(a1111.vaes).map((item) => profileFromResource(ResourceTypes.VAE, item)),
    ...asArray(a1111.controlnet).map((item) => profileFromResource(ResourceTypes.CONTROLNET, item)),
  ].filter((profile) => profile.name);
}

export function validateGenerationPlanResources(plan = {}, profiles = []) {
  const normalizedProfiles = asArray(profiles);
  const checkpoint = findProfile(normalizedProfiles, ResourceTypes.CHECKPOINT, plan.checkpoint);
  const issues = [];
  const warnings = [];

  if (!checkpoint) {
    issues.push({
      code: "CHECKPOINT_NOT_FOUND",
      message: `Checkpoint not found: ${plan.checkpoint || "(empty)"}`,
      resourceType: ResourceTypes.CHECKPOINT,
      resourceName: plan.checkpoint || "",
    });
    return compatibilityResult({ plan, checkpoint, issues, warnings });
  }

  if (checkpoint.baseType === BaseTypes.FLUX) {
    issues.push({
      code: "UNSUPPORTED_CHECKPOINT_TYPE",
      message: `Flux checkpoint is not supported by the current A1111 backend: ${checkpoint.name}`,
      resourceType: ResourceTypes.CHECKPOINT,
      resourceName: checkpoint.name,
    });
  }

  if (checkpoint.baseType === BaseTypes.UNKNOWN) {
    warnings.push({
      code: "CHECKPOINT_UNKNOWN_TYPE",
      message: `Checkpoint base type is unknown and will use SD1.5-safe sizing until annotated: ${checkpoint.name}`,
      resourceType: ResourceTypes.CHECKPOINT,
      resourceName: checkpoint.name,
    });
  }

  for (const lora of asArray(plan.lora)) {
    const name = typeof lora === "string" ? lora : lora?.name || lora?.alias || lora?.filename || "";
    const profile = findProfile(normalizedProfiles, ResourceTypes.LORA, name);
    if (!profile) {
      issues.push({
        code: "LORA_NOT_FOUND",
        message: `LoRA not found: ${name || "(empty)"}`,
        resourceType: ResourceTypes.LORA,
        resourceName: name,
      });
      continue;
    }
    if (!isProfileCompatibleWithCheckpoint(profile, checkpoint)) {
      issues.push({
        code: "LORA_INCOMPATIBLE",
        message: `LoRA ${profile.name} is ${profile.baseType}; checkpoint ${checkpoint.name} is ${checkpoint.baseType}.`,
        resourceType: ResourceTypes.LORA,
        resourceName: profile.name,
      });
    }
  }

  for (const control of asArray(plan.controlnet)) {
    const name = typeof control === "string" ? control : control?.name || control?.model || control?.filename || "";
    if (!name) continue;
    const profile = findProfile(normalizedProfiles, ResourceTypes.CONTROLNET, name);
    if (!profile) {
      issues.push({
        code: "CONTROLNET_NOT_FOUND",
        message: `ControlNet not found: ${name}`,
        resourceType: ResourceTypes.CONTROLNET,
        resourceName: name,
      });
      continue;
    }
    if (!isProfileCompatibleWithCheckpoint(profile, checkpoint)) {
      issues.push({
        code: "CONTROLNET_INCOMPATIBLE",
        message: `ControlNet ${profile.name} is ${profile.baseType}; checkpoint ${checkpoint.name} is ${checkpoint.baseType}.`,
        resourceType: ResourceTypes.CONTROLNET,
        resourceName: profile.name,
      });
    }
  }

  const preferredVae = resolvePreferredVae(checkpoint, normalizedProfiles);
  if (!isVaeCompatible(preferredVae, checkpoint, normalizedProfiles)) {
    issues.push({
      code: "VAE_INCOMPATIBLE",
      message: `VAE ${preferredVae} is not compatible with checkpoint ${checkpoint.name}.`,
      resourceType: ResourceTypes.VAE,
      resourceName: preferredVae,
    });
  }

  return compatibilityResult({ plan, checkpoint, issues, warnings, preferredVae });
}

export function resolvePlanRuntimeResources(plan = {}, profiles = []) {
  const compatibility = validateGenerationPlanResources(plan, profiles);
  if (!compatibility.ok) {
    const error = new Error(compatibility.issues.map((issue) => issue.message).join("; "));
    error.code = "RESOURCE_COMPATIBILITY_ERROR";
    error.compatibility = compatibility;
    throw error;
  }
  return {
    checkpoint: compatibility.checkpoint?.name || plan.checkpoint || "",
    vae: compatibility.resolvedVae || "Automatic",
    size: resolveRecommendedPlanSize(plan, compatibility.checkpoint),
    compatibility,
  };
}

export function compatibleLorasForCheckpoint(checkpointName, profiles = []) {
  const checkpoint = findProfile(profiles, ResourceTypes.CHECKPOINT, checkpointName);
  if (!checkpoint) return [];
  return profiles.filter((profile) => profile.type === ResourceTypes.LORA && isProfileCompatibleWithCheckpoint(profile, checkpoint));
}

export function compatibleControlNetForCheckpoint(checkpointName, profiles = []) {
  const checkpoint = findProfile(profiles, ResourceTypes.CHECKPOINT, checkpointName);
  if (!checkpoint) return [];
  return profiles.filter((profile) => profile.type === ResourceTypes.CONTROLNET && isProfileCompatibleWithCheckpoint(profile, checkpoint));
}

export function compactModelContextForPlanning(modelContext = {}, profiles = []) {
  const checkpoints = asArray(modelContext.checkpoints).map((checkpoint) => {
    const profile = findProfile(profiles, ResourceTypes.CHECKPOINT, resourceName(checkpoint));
    return profile ? { ...checkpoint, profile } : checkpoint;
  });
  const compatibleLoras = profiles.filter((profile) => profile.type === ResourceTypes.LORA && profile.baseType !== BaseTypes.UNKNOWN);
  const compatibleControlnet = profiles.filter((profile) => profile.type === ResourceTypes.CONTROLNET && profile.baseType !== BaseTypes.UNKNOWN);

  return {
    ...modelContext,
    checkpoints,
    loras: compatibleLoras,
    controlnet: compatibleControlnet,
    resourceProfiles: profiles,
    compatibilityPolicy: {
      default: "block",
      unknownResources: "blocked_until_annotated",
      vaeFallback: "Automatic",
      resizeMode: "plain_resize",
    },
  };
}

function compatibilityResult({ plan, checkpoint, issues, warnings, preferredVae }) {
  return {
    ok: issues.length === 0,
    issues,
    warnings,
    checkpoint,
    checkpointBaseType: checkpoint?.baseType || BaseTypes.UNKNOWN,
    resolvedVae: preferredVae || resolvePreferredVae(checkpoint, []),
    recommendedSize: checkpoint?.recommendedSize || recommendedSizeForBaseType(BaseTypes.UNKNOWN),
    resourceSummary: {
      checkpoint: plan.checkpoint || "",
      loras: asArray(plan.lora).map((lora) => typeof lora === "string" ? lora : lora?.name || lora?.alias || "").filter(Boolean),
      controlnet: asArray(plan.controlnet).map((control) => typeof control === "string" ? control : control?.name || control?.model || "").filter(Boolean),
    },
  };
}

function resolveRecommendedPlanSize(plan = {}, checkpoint) {
  const recommendedSize = checkpoint?.recommendedSize || recommendedSizeForBaseType(BaseTypes.UNKNOWN);
  const requestedWidth = numberOrFallback(plan.target_width || plan.width, 512);
  const requestedHeight = numberOrFallback(plan.target_height || plan.height, 512);
  const bucket = aspectBucket(requestedWidth, requestedHeight);
  return recommendedSize?.[bucket] || recommendedSizeForBaseType(BaseTypes.UNKNOWN)[bucket];
}

function aspectBucket(width, height) {
  const ratio = numberOrFallback(width, 512) / Math.max(1, numberOrFallback(height, 512));
  if (ratio < 0.9) return "portrait";
  if (ratio > 1.1) return "landscape";
  return "square";
}

function resolvePreferredVae(checkpoint, profiles = []) {
  if (!checkpoint) return "Automatic";
  const preferred = checkpoint.preferredVae || defaultVaeForBaseType(checkpoint.baseType);
  if (!preferred) return "Automatic";
  if (preferred === "Automatic") return preferred;
  const profile = findProfile(profiles, ResourceTypes.VAE, preferred);
  return profile?.name || preferred;
}

function isVaeCompatible(vaeName, checkpoint, profiles = []) {
  if (!checkpoint || !vaeName || vaeName === "Automatic") return true;
  const vae = findProfile(profiles, ResourceTypes.VAE, vaeName);
  if (!vae) return false;
  return isProfileCompatibleWithCheckpoint(vae, checkpoint);
}

function isProfileCompatibleWithCheckpoint(profile, checkpoint) {
  if (!profile || !checkpoint) return false;
  if (listIncludesCheckpoint(profile.blockedCheckpoints, checkpoint)) return false;
  if (listIncludesCheckpoint(profile.compatibleCheckpoints, checkpoint)) return true;
  if (profile.baseType === BaseTypes.UNIVERSAL) return true;
  if (profile.baseType === BaseTypes.UNKNOWN) return false;
  if (checkpoint.baseType === BaseTypes.UNKNOWN) return false;
  return profile.baseType === checkpoint.baseType;
}

function listIncludesCheckpoint(values = [], checkpoint = {}) {
  const checkpointKeys = [checkpoint.name, checkpoint.title, checkpoint.path].map(normalizeName).filter(Boolean);
  return asArray(values).some((value) => {
    const key = normalizeName(value);
    return key && checkpointKeys.some((checkpointKey) => checkpointKey === key || checkpointKey.includes(key) || key.includes(checkpointKey));
  });
}

function findProfile(profiles = [], type, value) {
  const normalizedType = String(type || "").toLowerCase();
  const candidate = normalizeName(value);
  if (!candidate) return null;
  const scoped = profiles.filter((profile) => profile.type === normalizedType);
  return scoped.find((profile) => normalizeName(profile.name) === candidate)
    || scoped.find((profile) => normalizeName(profile.title) === candidate)
    || scoped.find((profile) => normalizeName(profile.path) === candidate)
    || scoped.find((profile) => {
      const values = [profile.name, profile.title, profile.path].map(normalizeName).filter(Boolean);
      return values.some((item) => item.includes(candidate) || candidate.includes(item));
    })
    || null;
}

function inferBaseType(type, item = {}) {
  const text = [
    item.name,
    item.title,
    item.alias,
    item.filename,
    item.path,
    item.model_name,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\bflux\b/.test(text)) return BaseTypes.FLUX;
  if (/\bpony\b|ponyxl/.test(text)) return BaseTypes.PONY;
  if (/animaginexl|illustrious|sdxl|xl[_\s.-]?v?\d*|stable.?diffusion.?xl/.test(text)) return BaseTypes.SDXL;
  if (/vae-ft-mse|animevae|sd1[._-]?5|1\.5|v1-5|anything-v[345]|counterfeit|majicmix|chilloutmix/.test(text)) return BaseTypes.SD15;
  if (type === ResourceTypes.SAMPLER) return BaseTypes.UNIVERSAL;
  return BaseTypes.UNKNOWN;
}

function defaultVaeForBaseType(baseType) {
  if (baseType === BaseTypes.SDXL || baseType === BaseTypes.PONY || baseType === BaseTypes.UNKNOWN) return "Automatic";
  return "Automatic";
}

function recommendedSizeForBaseType(baseType) {
  if (baseType === BaseTypes.SDXL || baseType === BaseTypes.PONY) {
    return {
      square: { width: 1024, height: 1024 },
      portrait: { width: 832, height: 1216 },
      landscape: { width: 1216, height: 832 },
    };
  }
  return {
    square: { width: 512, height: 512 },
    portrait: { width: 512, height: 768 },
    landscape: { width: 768, height: 512 },
  };
}

function inferTriggerWords(item = {}) {
  const alias = String(item.alias || item.name || "").trim();
  return alias ? [alias] : [];
}

function inferControlType(item = {}) {
  const text = resourceName(item).toLowerCase();
  if (text.includes("canny")) return "canny";
  if (text.includes("depth")) return "depth";
  if (text.includes("openpose") || text.includes("pose")) return "openpose";
  if (text.includes("tile")) return "tile";
  if (text.includes("lineart")) return "lineart";
  return "";
}

function resourceName(resource) {
  return String(resource?.title || resource?.name || resource?.alias || resource?.filename || "").trim();
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(safetensors|ckpt|pt|pth)$/g, "")
    .replace(/\[[a-f0-9]{8,}\]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
