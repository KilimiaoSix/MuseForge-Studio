import { normalizeGenerationPlan, ProviderTypes } from "@sd-agent-studio/shared";

export { ProviderTypes };

export function createProvider(config = {}) {
  const type = config.type || process.env.AGENT_PROVIDER || ProviderTypes.OPENAI_COMPATIBLE;

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

  async createGenerationPlan({ userRequest }) {
    return normalizeGenerationPlan({
      positive_prompt: buildMockPrompt(userRequest),
      negative_prompt: "bad hands, extra fingers, low quality, blurry, watermark, text, logo, deformed face",
      checkpoint: "animagineXL40_v4Opt.safetensors",
      lora: [{ name: "portrait", weight: 0.65 }],
      width: 832,
      height: 1472,
      steps: 28,
      cfg_scale: 6.5,
      sampler: "DPM++ 2M Karras",
      batch_size: 4,
      hires_fix: true,
      adetailer: true,
      rationale: "Mock Provider：根据中文需求生成竖版动漫插画方案。配置真实 Provider 后会调用大模型。",
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: generationPlannerSystemPrompt },
          { role: "user", content: JSON.stringify({ userRequest, modelContext }) },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return normalizeGenerationPlan(JSON.parse(content));
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
        system: generationPlannerSystemPrompt,
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
    return normalizeGenerationPlan(JSON.parse(extractJson(text)));
  }
}

const generationPlannerSystemPrompt = `
你是 SD Agent Studio 的生图方案规划器。
把用户的中文自然语言需求转换为 Stable Diffusion WebUI 可执行的 JSON。
只输出 JSON，不输出 Markdown。
字段必须包含：
task_type, positive_prompt, negative_prompt, checkpoint, lora, controlnet,
width, height, sampler, steps, cfg_scale, seed, batch_size, hires_fix, adetailer, rationale。
prompt 可以使用英文 tag，rationale 使用中文。
不要编造不存在的模型；如果 modelContext 提供模型列表，优先从列表中选择。
`;

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

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
}

