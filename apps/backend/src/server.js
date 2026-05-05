import { createServer } from "node:http";
import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createProvider } from "@sd-agent-studio/model-providers";
import { normalizeGenerationPlan } from "@sd-agent-studio/shared";
import { getBackendName, getEngineModels, getEngineStatus, runGeneration } from "./engines.js";

const host = process.env.SD_AGENT_HOST || "127.0.0.1";
const port = Number(process.env.SD_AGENT_PORT || 8787);
const webuiBaseUrl = trimTrailingSlash(process.env.A1111_BASE_URL || process.env.SD_WEBUI_BASE_URL || "http://127.0.0.1:7860");

if (process.argv.includes("--check")) {
  console.log("backend scaffold ok");
  process.exit(0);
}

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

  if (req.method === "GET" && url.pathname === "/health") {
    const engineStatus = await getEngineStatus();
    sendJson(res, 200, {
      ok: true,
      inferenceBackend: getBackendName(),
      webuiBaseUrl,
      comfyuiBaseUrl: process.env.COMFYUI_BASE_URL || "http://127.0.0.1:8188",
      provider: process.env.AGENT_PROVIDER || "mock/openai-compatible",
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

  if (req.method === "POST" && url.pathname === "/api/generate/run") {
    const body = await readJson(req);
    const plan = normalizeGenerationPlan(body.plan || {});
    const result = await runGeneration(plan, body.backend || getBackendName());
    sendJson(res, 200, result);
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
  const root = process.env.SD_WEBUI_ROOT || findLikelyWebuiRoot();
  const scan = async (relativePath, extensions) => scanFiles(join(root, relativePath), extensions);

  return {
    webuiRoot: root,
    checkpoints: await scan("models/Stable-diffusion", [".safetensors", ".ckpt"]),
    loras: await scan("models/Lora", [".safetensors", ".pt"]),
    vaes: await scan("models/VAE", [".safetensors", ".ckpt", ".pt"]),
    controlnet: await scan("models/ControlNet", [".safetensors", ".pth", ".pt"]),
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
  return join(process.cwd(), "..", "..", "..", "sd-webui-aki-v4.11.1-cu128");
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

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload, null, 2));
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
