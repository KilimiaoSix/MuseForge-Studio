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
      target_width: null,
      target_height: null,
      steps: inferred.steps,
      cfg_scale: inferred.cfg_scale,
      sampler: inferred.sampler,
      batch_size: inferred.batch_size,
      hires_fix: false,
      adetailer: false,
      rationale: checkpoint
        ? `Mock Provider：已选择 ${checkpoint}，使用简洁 tags 单次 txt2img。`
        : "Mock Provider：未检测到 checkpoint，使用简洁 tags 单次 txt2img。",
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
- Simplified tag mode is always single-pass: target_width=null, target_height=null, hires_fix=false and adetailer=false.
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
- Treat modelContext.promptTagTool as local prompt tag context.
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
当前模式只需要生成简洁 tags，不需要解释推理过程，不需要工具工作流。
画面尽量简单：单主体、简单背景、少量稳定元素；避免复杂场景、多人、复杂姿势、复杂光影。
positive_prompt 控制在 8-18 个 comma-separated tags；优先 Danbooru/SD 常见标签。
negative_prompt 控制在 8-14 个 comma-separated tags。
不要编造不存在的模型；如果 modelContext 提供模型列表，checkpoint 必须从列表中选择并完整输出 title/name。
如果用户要求特定角色、画风、服装或指定 LoRA，并且 modelContext.loras 提供了匹配项，可以在 lora 字段输出数组；每项格式为 {"name":"LoRA 名称或 alias","weight":0.65,"trigger_words":["必要触发词"]}。name 必须来自 modelContext.loras 的 name/alias/filename，不要编造不存在的 LoRA。
如果选择 LoRA，把真实 trigger_words 自然加入 positive_prompt，并在 rationale 中说明使用原因和权重。没有 trigger_words 的 LoRA 不要把 LoRA 名称、文件名、中文标题或翻译名写入 positive_prompt。角色 LoRA 通常从 0.6-0.85 起步；风格 LoRA 通常从 0.35-0.7 起步，避免过高导致画面塌陷。
你需要像专业 Stable Diffusion 参数规划师一样，根据用户意图自由判断合适参数，并把判断结果写入 JSON 字段。
width/height 永远表示模型舒适的基础生成尺寸，不表示最终输出大图尺寸。
如果用户要求手机壁纸、大图、高清、4K、导出尺寸，或明确输入 768x1344、1024x1536 等尺寸，仍然只选择模型舒适的基础生成尺寸；target_width/target_height 必须为 null。
通用 SD1.5 友好基础尺寸：方图 512x512，竖图 512x768，横图 768x512；必要时可用接近比例的 64 倍数，但不要直接用大目标尺寸首轮生成。
SDXL/Pony 友好基础尺寸：方图 1024x1024，竖图 832x1216，横图 1216x832；优先使用 checkpoint profile 中的 recommendedSize。
不要规划普通 resize、Extras、Hires Fix、二次重绘或视觉评级；target_width/target_height 必须为 null，hires_fix=false。
默认值只在用户没有提供用途、画幅、质量、数量或风格线索时兜底：width=512、height=512、target_width=null、target_height=null、steps=8、cfg_scale=5、sampler=Euler a、batch_size=1、seed=-1、hires_fix=false、adetailer=false。
如果用户描述了用途或构图，例如手机壁纸、竖屏、头像、横幅、海报、全身、半身、近景、批量方案，你必须据此选择基础 width/height、steps、cfg_scale、sampler、batch_size 和 seed。
如果 modelContext 提供 samplers，sampler 必须从 samplers[].name 中选择，不要输出不存在的变体名。
不要为了保守而忽略明确或隐含的画幅需求；rationale 必须解释为什么选择这些参数。
rationale 简短说明：当前只生成简洁 tags，并使用 A1111 单次 txt2img。
adetailer 必须为 false。
在当前 MuseForge 简化模式下，target_width=null, target_height=null, hires_fix=false, adetailer=false。
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
  const batch = Math.min(4, Math.max(1, Number(wantsBatch?.[1] || wantsBatch?.[2] || 1)));

  if (wantsVertical) {
    return {
      width: 512,
      height: 768,
      steps: wantsDetail ? 16 : 10,
      cfg_scale: 5.5,
      sampler: "Euler a",
      batch_size: batch,
      target_width: null,
      target_height: null,
      hires_fix: false,
    };
  }

  if (wantsWide) {
    return {
      width: 768,
      height: 512,
      steps: wantsDetail ? 16 : 10,
      cfg_scale: 5.5,
      sampler: "Euler a",
      batch_size: batch,
      target_width: null,
      target_height: null,
      hires_fix: false,
    };
  }

  return {
    width: 512,
    height: 512,
    steps: wantsDetail || wantsAvatar ? 12 : 8,
    cfg_scale: 5,
    sampler: "Euler a",
    batch_size: batch,
    target_width: null,
    target_height: null,
    hires_fix: false,
  };
}

function inferAspect(userRequest = "") {
  const text = String(userRequest || "");
  if (/手机壁纸|竖屏|竖幅|portrait|海报|全身|头像/.test(text)) return "portrait";
  if (/横幅|横屏|宽屏|banner|landscape|电影画幅/.test(text)) return "landscape";
  return "square";
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
