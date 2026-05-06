import { normalizeGenerationPlan, ProviderTypes } from "@sd-agent-studio/shared";

export { ProviderTypes };

export function createProvider(config = {}) {
  const type = config.type || process.env.AGENT_PROVIDER || ProviderTypes.OPENAI_COMPATIBLE;

  if (type === ProviderTypes.MOCK || type === "mock") {
    return new MockProvider();
  }

  if (type === ProviderTypes.OPENAI || type === ProviderTypes.OPENAI_COMPATIBLE || type === ProviderTypes.LOCAL) {
    return new OpenAICompatibleProvider({
      type,
      baseUrl: config.baseUrl || process.env.AGENT_BASE_URL || process.env.OPENAI_BASE_URL,
      apiKey: config.apiKey || process.env.AGENT_API_KEY || process.env.OPENAI_API_KEY,
      model: config.model || process.env.AGENT_MODEL || process.env.OPENAI_MODEL,
    });
  }

  if (type === ProviderTypes.ANTHROPIC) {
    return new AnthropicProvider({
      baseUrl: config.baseUrl || process.env.ANTHROPIC_BASE_URL,
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
      model: config.model || process.env.ANTHROPIC_MODEL,
    });
  }

  return new MockProvider();
}

export class MockProvider {
  constructor() {
    this.type = "mock";
  }

  async createGenerationPlan({ userRequest, modelContext = {} }) {
    const checkpoint = selectCheckpoint(modelContext);
    const inferred = inferMockParameters(userRequest);

    return normalizeGenerationPlan({
      positive_prompt: buildMockPrompt(userRequest),
      negative_prompt: "bad hands, extra fingers, low quality, blurry, watermark, text, logo, deformed face",
      checkpoint,
      lora: [],
      width: inferred.width,
      height: inferred.height,
      target_width: inferred.target_width,
      target_height: inferred.target_height,
      steps: inferred.steps,
      cfg_scale: inferred.cfg_scale,
      sampler: inferred.sampler,
      batch_size: inferred.batch_size,
      hires_fix: inferred.hires_fix,
      adetailer: false,
      rationale: checkpoint
        ? `Mock Provider：已选择 ${checkpoint}。先用 ${inferred.width}x${inferred.height} 快速构图${inferred.target_width ? `，再通过 A1111 普通 resize 输出 ${inferred.target_width}x${inferred.target_height}` : ""}。`
        : `Mock Provider：未检测到 checkpoint。先用 ${inferred.width}x${inferred.height} 快速构图${inferred.target_width ? `，再通过 A1111 普通 resize 输出 ${inferred.target_width}x${inferred.target_height}` : ""}。`,
    });
  }
}

export class OpenAICompatibleProvider {
  constructor({ type = ProviderTypes.OPENAI_COMPATIBLE, baseUrl, apiKey, model }) {
    this.type = type;
    this.baseUrl = trimTrailingSlash(baseUrl || "http://127.0.0.1:1234/v1");
    this.apiKey = apiKey || "";
    this.model = model || "local-model";
  }

  async createGenerationPlan({ userRequest, modelContext = {} }) {
    if (!this.baseUrl || !this.model) {
      return new MockProvider().createGenerationPlan({ userRequest, modelContext });
    }

    const payload = {
      model: this.model,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: plannerSystemPrompt },
        { role: "user", content: JSON.stringify({ userRequest, modelContext }) },
      ],
    };

    let data;
    try {
      data = await this.requestChatCompletion(payload);
    } catch (error) {
      if (!isUnsupportedResponseFormatError(error)) throw error;
      const { response_format: _responseFormat, ...fallbackPayload } = payload;
      data = await this.requestChatCompletion(fallbackPayload);
    }

    const content = data.choices?.[0]?.message?.content || "{}";
    return normalizePlanForModelContext(JSON.parse(extractJson(content)), modelContext);
  }

  async requestChatCompletion(payload) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Provider request failed: ${response.status} ${await response.text()}`);
    }

    return response.json();
  }
}

export class AnthropicProvider {
  constructor({ baseUrl, apiKey, model }) {
    this.type = ProviderTypes.ANTHROPIC;
    this.baseUrl = trimTrailingSlash(baseUrl || "https://api.anthropic.com");
    this.apiKey = apiKey || "";
    this.model = model || "claude-3-5-sonnet-latest";
  }

  async createGenerationPlan({ userRequest, modelContext = {} }) {
    if (!this.apiKey) {
      return new MockProvider().createGenerationPlan({ userRequest, modelContext });
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1600,
        temperature: 0.4,
        system: plannerSystemPrompt,
        messages: [
          { role: "user", content: JSON.stringify({ userRequest, modelContext }) },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic provider request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const text = data.content?.find((item) => item.type === "text")?.text || "{}";
    return normalizePlanForModelContext(JSON.parse(extractJson(text)), modelContext);
  }
}

const resourceCompatibilitySystemPrompt = `
Hard resource rules:
- Use only checkpoints, LoRA, ControlNet and samplers present in modelContext.
- If modelContext.resourceProfiles is present, LoRA and ControlNet must be compatible with the chosen checkpoint baseType.
- Do not use unknown LoRA or unknown ControlNet; they are blocked until annotated by the user.
- Do not output VAE; the backend chooses checkpoint preferredVae automatically.
- For SDXL/Pony checkpoints, prefer profile recommended base sizes: square 1024x1024, portrait 832x1216, landscape 1216x832.
- For SD1.5 checkpoints, prefer profile recommended base sizes: square 512x512, portrait 512x768, landscape 768x512.
- target_width/target_height means plain resize by default. In that case hires_fix must be false.
- Only enable Hires Fix when the user explicitly asks for second-pass redraw, highres fix, or refinement; then use hires_fix {"enabled":true,"mode":"hires","denoising_strength":0.2,"upscaler":"Lanczos"}.
- Never use Latent upscaler for plain resize.
`;

const promptAllInOneSystemPrompt = `
Prompt writing rules:
- When modelContext.promptTools.promptAllInOne.installed is true, write prompts in a prompt-all-in-one friendly tag workflow.
- positive_prompt must be comma-separated English Stable Diffusion tags, not long prose sentences.
- Organize positive_prompt tags in this order: subject, appearance, clothing/accessories, pose/composition, scene/background, lighting, style/quality, camera/detail.
- Do not include group headings in positive_prompt; only output the tags themselves separated by ASCII commas.
- negative_prompt must also be comma-separated English tags, grouped by quality problems, anatomy problems, artifacts, text/logo/watermark, and unwanted style.
- If using LoRA, place its trigger words near the matching subject/style tags in positive_prompt, but never invent LoRA names or trigger words.
- Keep prompts compact and editable: prefer short tag phrases such as "1girl", "silver hair", "rainy night", "cinematic lighting", "best quality".
- Avoid Chinese punctuation inside positive_prompt and negative_prompt.
- Treat modelContext.promptTagTool as the result of an internal tool call named prompt-all-in-one.tag_search.
- modelContext.toolCalls/toolResults may contain the same result in tool-call format; treat toolResults[].output.candidates as authoritative retrieved SD tags.
- If modelContext.promptTagTool.ok is true, prefer modelContext.promptTagTool.candidates[].name for SD prompt tags whenever they match the user request.
- Use modelContext.promptTagTool.groups to understand which plugin groups are relevant, especially for SD1.5 tag conventions.
- Do not copy translations into prompts; translations are only explanations. Use candidates[].name exactly as the English tag.
- If the user asks for a concept and matching candidates exist, include the best matching candidate tags before falling back to your own SD knowledge.
- If candidates conflict with available LoRA/checkpoint compatibility rules, resource compatibility rules still win.
`;

const generationPlannerSystemPrompt = `
你是 SD Agent Studio 的生图方案规划器。
把用户的中文自然语言需求转换为 Stable Diffusion WebUI 可执行的 JSON。
只输出 JSON，不输出 Markdown。
字段必须包含：
task_type, positive_prompt, negative_prompt, checkpoint, lora, controlnet,
width, height, target_width, target_height, sampler, steps, cfg_scale, seed, batch_size, hires_fix, adetailer, rationale。
prompt 可以使用英文 tag，rationale 使用中文。
不要编造不存在的模型；如果 modelContext 提供模型列表，checkpoint 必须从列表中选择并完整输出 title/name。
如果用户要求特定角色、画风、服装或指定 LoRA，并且 modelContext.loras 提供了匹配项，可以在 lora 字段输出数组；每项格式为 {"name":"LoRA 名称或 alias","weight":0.65,"trigger_words":["必要触发词"]}。name 必须来自 modelContext.loras 的 name/alias/filename，不要编造不存在的 LoRA。
如果选择 LoRA，把必要触发词自然加入 positive_prompt，并在 rationale 中说明使用原因和权重。角色 LoRA 通常从 0.6-0.85 起步；风格 LoRA 通常从 0.35-0.7 起步，避免过高导致画面塌陷。
你需要像专业 Stable Diffusion 参数规划师一样，根据用户意图自由判断合适参数，并把判断结果写入 JSON 字段。
width/height 永远表示模型舒适的基础生成尺寸，不表示最终输出大图尺寸。
如果用户要求手机壁纸、大图、高清、4K、导出尺寸，或明确输入 768x1344、1024x1536 等尺寸，把最终尺寸写入 target_width/target_height，同时保持 width/height 为相同比例下更适合首轮生成的推荐尺寸。
通用 SD1.5 友好基础尺寸：方图 512x512，竖图 512x768，横图 768x512；必要时可用接近比例的 64 倍数，但不要直接用大目标尺寸首轮生成。
SDXL/Pony 友好基础尺寸：方图 1024x1024，竖图 832x1216，横图 1216x832；优先使用 checkpoint profile 中的 recommendedSize。
如果 target_width/target_height 与 width/height 不一致，默认是普通 resize，hires_fix 必须为 false；后端会使用 A1111 extras 普通 resize 输出目标尺寸。
只有用户明确要求“二次重绘、高清修复、重新细化、Hires Fix”时，hires_fix 才能是对象：{"enabled":true,"mode":"hires","target_width":目标宽,"target_height":目标高,"denoising_strength":0.2,"upscaler":"Lanczos","second_pass_steps":max(10, round(steps*0.6))}。
如果没有高清/目标尺寸需求，target_width/target_height 为 null，hires_fix=false。
默认值只在用户没有提供用途、画幅、质量、数量或风格线索时兜底：width=512、height=512、target_width=null、target_height=null、steps=8、cfg_scale=5、sampler=Euler a、batch_size=1、seed=-1、hires_fix=false、adetailer=false。
如果用户描述了用途或构图，例如手机壁纸、竖屏、头像、横幅、海报、全身、半身、近景、批量方案，你必须据此选择基础 width/height、目标 target_width/target_height、steps、cfg_scale、sampler、batch_size 和 seed。
如果 modelContext 提供 samplers，sampler 必须从 samplers[].name 中选择，不要输出不存在的变体名。
不要为了保守而忽略明确或隐含的画幅需求；rationale 必须解释为什么选择这些参数。
rationale 必须说明：先按模型舒适尺寸快速构图，再按需要通过 A1111 普通 resize 到目标尺寸；只有明确要求二次重绘时才使用 Hires Fix。
adetailer 由需求判断：只有用户明确要求脸部修复、精修或最终成片时才开启。
`;

const plannerSystemPrompt = `${resourceCompatibilitySystemPrompt}
${promptAllInOneSystemPrompt}
${generationPlannerSystemPrompt}`;

function buildMockPrompt(userRequest = "") {
  return [
    "1girl",
    "solo",
    "beautiful detailed eyes",
    "anime illustration",
    "cinematic lighting",
    "high quality",
    userRequest.includes("雨") ? "rainy night" : "soft ambient light",
    userRequest.includes("头像") ? "portrait" : "half body portrait",
    userRequest.includes("银发") ? "silver hair" : "elegant character design",
    userRequest.includes("黑") ? "black dress" : "detailed outfit",
  ].join(", ");
}

function selectCheckpoint(modelContext = {}) {
  const checkpoints = Array.isArray(modelContext.checkpoints) ? modelContext.checkpoints : [];
  const first = checkpoints[0];
  return first?.title || first?.name || "";
}

function inferMockParameters(userRequest = "") {
  const text = String(userRequest);
  const wantsVertical = /手机壁纸|竖屏|竖幅|portrait|海报|全身/.test(text);
  const wantsWide = /横幅|横屏|宽屏|banner|landscape|电影画幅/.test(text);
  const wantsAvatar = /头像|社媒头像|profile|icon/.test(text);
  const wantsDetail = /精细|精致|高质量|高清|最终|成片|细节/.test(text);
  const wantsBatch = text.match(/(\d+)\s*张|出\s*(\d+)\s*张/);
  const explicitSize = text.match(/(\d{3,4})\s*[xX×*]\s*(\d{3,4})/);
  const batch = Math.min(4, Math.max(1, Number(wantsBatch?.[1] || wantsBatch?.[2] || 1)));
  const explicitTarget = explicitSize ? normalizeTargetSize(Number(explicitSize[1]), Number(explicitSize[2])) : null;

  if (wantsVertical) {
    const target = explicitTarget || (wantsDetail || /手机壁纸|壁纸|高清|成片/.test(text) ? { width: 768, height: 1152 } : null);
    return {
      width: 512,
      height: 768,
      steps: wantsDetail ? 16 : 10,
      cfg_scale: 5.5,
      sampler: "Euler a",
      batch_size: batch,
      ...targetFields(target, 512, 768, wantsDetail ? 16 : 10),
    };
  }

  if (wantsWide) {
    const target = explicitTarget || (wantsDetail || /高清|成片/.test(text) ? { width: 1152, height: 768 } : null);
    return {
      width: 768,
      height: 512,
      steps: wantsDetail ? 16 : 10,
      cfg_scale: 5.5,
      sampler: "Euler a",
      batch_size: batch,
      ...targetFields(target, 768, 512, wantsDetail ? 16 : 10),
    };
  }

  const target = explicitTarget;
  return {
    width: 512,
    height: 512,
    steps: wantsDetail || wantsAvatar ? 12 : 8,
    cfg_scale: 5,
    sampler: "Euler a",
    batch_size: batch,
    ...targetFields(target, 512, 512, wantsDetail || wantsAvatar ? 12 : 8),
  };
}

function normalizeTargetSize(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: Math.max(256, Math.min(4096, Math.round(width / 8) * 8)),
    height: Math.max(256, Math.min(4096, Math.round(height / 8) * 8)),
  };
}

function targetFields(target, baseWidth, baseHeight, steps) {
  if (!target || target.width === baseWidth && target.height === baseHeight) {
    return {
      target_width: null,
      target_height: null,
      hires_fix: false,
    };
  }

  return {
    target_width: target.width,
    target_height: target.height,
    hires_fix: false,
  };
}

function normalizePlanForModelContext(plan = {}, modelContext = {}) {
  const normalized = normalizeGenerationPlan(plan);
  const checkpoint = resolveCheckpoint(normalized.checkpoint, modelContext) || selectCheckpoint(modelContext);
  if (checkpoint) normalized.checkpoint = checkpoint;
  normalized.sampler = resolveSampler(normalized.sampler, modelContext) || normalized.sampler;
  normalized.lora = resolveLoras(normalized.lora, modelContext);
  return normalized;
}

function resolveCheckpoint(value, modelContext = {}) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";

  const checkpoints = Array.isArray(modelContext.checkpoints) ? modelContext.checkpoints : [];
  const choices = checkpoints.flatMap((checkpoint) => {
    const display = checkpoint?.title || checkpoint?.name || "";
    return [
      display,
      checkpoint?.name,
      checkpoint?.title,
      checkpoint?.model_name,
      checkpoint?.filename,
    ].filter(Boolean).map((item) => ({ display, value: String(item) }));
  });

  const exact = choices.find((choice) => choice.value === candidate);
  if (exact) return exact.display || exact.value;

  const lowerCandidate = candidate.toLowerCase();
  const loose = choices.find((choice) => {
    const lowerValue = choice.value.toLowerCase();
    return lowerValue.includes(lowerCandidate) || lowerCandidate.includes(lowerValue);
  });
  return loose?.display || "";
}

function resolveLoras(value, modelContext = {}) {
  const loras = Array.isArray(value) ? value : [];
  const available = Array.isArray(modelContext.loras) ? modelContext.loras : [];
  if (!loras.length || !available.length) return [];

  return loras.map((item) => {
    const candidate = typeof item === "string" ? item : item?.name || item?.alias || item?.filename || "";
    const match = resolveLora(candidate, available);
    if (!match) return null;
    return {
      ...(typeof item === "object" ? item : {}),
      name: match.name || match.alias || match.filename,
      alias: match.alias,
      weight: Number.isFinite(Number(item?.weight)) ? Number(item.weight) : 0.75,
      trigger_words: Array.isArray(item?.trigger_words) ? item.trigger_words : [],
    };
  }).filter(Boolean);
}

function resolveLora(value, available = []) {
  const candidate = String(value || "").trim();
  if (!candidate) return null;
  const choices = available.flatMap((lora) => {
    const display = lora?.name || lora?.alias || lora?.filename || "";
    return [display, lora?.name, lora?.alias, lora?.filename, lora?.path]
      .filter(Boolean)
      .map((item) => ({ display, value: String(item), lora }));
  });
  const normalizedCandidate = normalizeLoraName(candidate);
  return choices.find((choice) => normalizeLoraName(choice.value) === normalizedCandidate)?.lora ||
    choices.find((choice) => {
      const normalizedValue = normalizeLoraName(choice.value);
      return normalizedValue.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedValue);
    })?.lora ||
    null;
}

function normalizeLoraName(value) {
  return String(value || "").toLowerCase().replace(/\.(safetensors|ckpt|pt)$/i, "").replace(/[_\s-]+/g, "");
}

function isUnsupportedResponseFormatError(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("response_format") ||
    message.includes("json_object") ||
    message.includes("json_schema")
  );
}

function resolveSampler(value, modelContext = {}) {
  const candidate = String(value || "").trim();
  if (!candidate) return "";

  const samplers = Array.isArray(modelContext.samplers) ? modelContext.samplers : [];
  if (!samplers.length) return candidate;

  const choices = samplers.flatMap((sampler) => [
    sampler?.name,
    ...(Array.isArray(sampler?.aliases) ? sampler.aliases : []),
  ].filter(Boolean).map((item) => ({ display: sampler.name || String(item), value: String(item) })));

  const exact = choices.find((choice) => choice.value.toLowerCase() === candidate.toLowerCase());
  if (exact) return exact.display;

  const lowerCandidate = candidate.toLowerCase().replace(/\s+karras\b/g, "");
  const loose = choices.find((choice) => {
    const lowerValue = choice.value.toLowerCase();
    return lowerValue === lowerCandidate || lowerValue.includes(lowerCandidate) || lowerCandidate.includes(lowerValue);
  });
  return loose?.display || samplers[0]?.name || "";
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}
