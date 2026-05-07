import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = join(projectRoot, "data");
const pullTasksPath = join(projectRoot, "data", "local-llm-pulls.json");
const installTaskPath = join(projectRoot, "data", "local-llm-install.json");
mkdirSync(dataDir, { recursive: true });
const pullTasks = loadPullTasks();
let installTask = loadInstallTask();

export const localGemmaProvider = Object.freeze({
  name: "Local Gemma 4 E4B",
  type: "local",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "gemma4:e4b",
});

export async function getLocalLlmStatus() {
  const ollamaCommand = resolveOllamaCommand();
  const [command, service, models] = await Promise.all([
    ollamaCommand ? runCommand(ollamaCommand, ["--version"]) : Promise.resolve({ ok: false, stdout: "", stderr: "", error: "ollama command not found" }),
    fetchJsonSafe("http://127.0.0.1:11434/api/version"),
    fetchJsonSafe("http://127.0.0.1:11434/api/tags"),
  ]);
  const installedModels = Array.isArray(models?.models) ? models.models.map(normalizeInstalledModel) : [];
  const modelNames = installedModels.map((model) => model.name);
  const serviceOnline = Boolean(service);
  const modelInstalled = modelNames.some((name) => name === localGemmaProvider.model || name.startsWith(`${localGemmaProvider.model}:`));
  return {
    runtime: "ollama",
    installed: command.ok || serviceOnline,
    commandPath: ollamaCommand || "",
    version: command.ok ? command.stdout.trim() : service?.version || "",
    serviceOnline,
    baseUrl: localGemmaProvider.baseUrl,
    model: localGemmaProvider.model,
    modelInstalled,
    models: modelNames,
    installedModels,
    error: command.ok || serviceOnline ? "" : command.error,
  };
}

export function getLocalLlmInstallTask() {
  return installTask ? sanitizeInstallTask(installTask) : null;
}

export async function installLocalLlmRuntime() {
  if (installTask && ["queued", "running"].includes(installTask.status)) {
    return { ok: true, task: sanitizeInstallTask(installTask) };
  }

  installTask = createInstallTask();
  void runInstallTask(installTask.id);
  return { ok: true, task: sanitizeInstallTask(installTask) };
}

export async function pullGemmaModel() {
  return pullLocalLlmModel(localGemmaProvider.model);
}

export async function pullLocalLlmModel(model = localGemmaProvider.model, options = {}) {
  const ollamaCommand = resolveOllamaCommand();
  const modelName = String(model || localGemmaProvider.model).trim();
  if (!ollamaCommand) {
    return {
      ok: false,
      model: modelName,
      stdout: "",
      stderr: "",
      error: "ollama command not found. Install Ollama or add ollama.exe to PATH.",
    };
  }
  if (!modelName) {
    return {
      ok: false,
      model: "",
      stdout: "",
      stderr: "",
      error: "model is required",
    };
  }
  const preflight = await getOllamaModelInfo(modelName);
  if (preflight.fit?.level === "danger" && !options.force) {
    return {
      ok: false,
      blocked: true,
      model: modelName,
      preflight,
      stdout: "",
      stderr: "",
      error: preflight.fit.reason || "Model is not recommended for this machine. Pass force=true to pull anyway.",
    };
  }
  const runningTask = listLocalLlmPullTasks().find((task) => task.model === modelName && ["queued", "running"].includes(task.status));
  if (runningTask) return { ok: true, task: runningTask, model: modelName, preflight };

  const task = createPullTask(modelName, preflight);
  void runPullTask(task.id);
  return { ok: true, task, model: modelName, preflight };
}

export function listLocalLlmPullTasks({ limit = 20 } = {}) {
  return [...pullTasks.values()]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit)
    .map(sanitizePullTask);
}

export function getLocalLlmPullTask(id = "") {
  const task = pullTasks.get(String(id || ""));
  return task ? sanitizePullTask(task) : null;
}

export async function deleteLocalLlmModel(model = "") {
  const ollamaCommand = resolveOllamaCommand();
  const modelName = String(model || "").trim();
  if (!ollamaCommand) {
    return {
      ok: false,
      model: modelName,
      stdout: "",
      stderr: "",
      error: "ollama command not found. Install Ollama or add ollama.exe to PATH.",
    };
  }
  if (!modelName) {
    return {
      ok: false,
      model: "",
      stdout: "",
      stderr: "",
      error: "model is required",
    };
  }
  const command = await runCommand(ollamaCommand, ["rm", modelName], { timeoutMs: 1000 * 60 * 10 });
  return {
    ok: command.ok,
    model: modelName,
    stdout: command.stdout,
    stderr: command.stderr,
    error: command.error,
  };
}

export async function searchOllamaLibrary(query = "") {
  const rawQuery = String(query || "").trim();
  const searchQuery = rawQuery || "llama";
  const url = `https://ollama.com/search?q=${encodeURIComponent(searchQuery)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Ollama library search failed: ${response.status}`);
    const html = await response.text();
    const names = [...html.matchAll(/\/library\/([a-zA-Z0-9._-]+)/g)]
      .map((match) => match[1])
      .filter(Boolean);
    const unique = [...new Set(names)].slice(0, 30);
    return {
      ok: true,
      source: "ollama.com",
      query: searchQuery,
      models: unique.map((name) => ({ name, pullName: name, url: `https://ollama.com/library/${name}` })),
    };
  } catch (error) {
    return {
      ok: false,
      source: "fallback",
      query: searchQuery,
      error: error.message,
      models: fallbackLibraryModels(searchQuery),
    };
  }
}

export async function getOllamaModelInfo(model = "") {
  const rawModel = String(model || "").trim();
  const baseName = rawModel.split(":")[0];
  if (!baseName) {
    return { ok: false, model: rawModel, error: "model is required", tags: [], fit: estimateModelFit(rawModel, 0) };
  }

  try {
    const [htmlResponse, hardware] = await Promise.all([
      fetch(`https://ollama.com/library/${encodeURIComponent(baseName)}`, { signal: AbortSignal.timeout(10000) }),
      getHardwareProfile(),
    ]);
    if (!htmlResponse.ok) throw new Error(`Ollama model page failed: ${htmlResponse.status}`);
    const html = await htmlResponse.text();
    const tags = parseOllamaTags(html, baseName);
    const selectedTag = chooseModelTag(rawModel, tags);
    return {
      ok: true,
      source: "ollama.com",
      model: rawModel,
      baseName,
      selectedTag,
      tags,
      hardware,
      fit: estimateModelFit(selectedTag || rawModel, selectedTag ? selectedTag.sizeGb : 0, hardware),
    };
  } catch (error) {
    const hardware = await getHardwareProfile();
    return {
      ok: false,
      source: "fallback",
      model: rawModel,
      baseName,
      selectedTag: { name: rawModel, sizeGb: 0, sizeLabel: "", context: "", family: "" },
      tags: [],
      hardware,
      fit: estimateModelFit(rawModel, 0, hardware),
      error: error.message,
    };
  }
}

export async function stopLocalLlmModel(model = localGemmaProvider.model) {
  const ollamaCommand = resolveOllamaCommand();
  const modelName = String(model || localGemmaProvider.model).trim();
  if (!ollamaCommand || !modelName) {
    return {
      runtime: "ollama",
      model: modelName,
      stopped: false,
      error: ollamaCommand ? "model is empty" : "ollama command not found",
    };
  }

  const command = await runCommand(ollamaCommand, ["stop", modelName], { timeoutMs: 30000 });
  return {
    runtime: "ollama",
    model: modelName,
    stopped: command.ok,
    stdout: command.stdout,
    stderr: command.stderr,
    error: command.error,
  };
}

export function resolveOllamaCommand() {
  const candidates = [
    process.env.OLLAMA_EXE,
    "ollama",
    "/opt/homebrew/bin/ollama",
    "/usr/local/bin/ollama",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\Ollama\\ollama.exe` : "",
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Ollama\\ollama.exe` : "",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "ollama" && isCommandAvailable(candidate)) return candidate;
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }

  return "";
}

function isCommandAvailable(command) {
  const pathValue = process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const extension of extensions) {
      try {
        if (existsSync(join(dir, `${command}${extension}`))) return true;
      } catch {
        continue;
      }
    }
  }
  return false;
}

async function fetchJsonSafe(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function runCommand(command, args = [], { timeoutMs = 10000 } = {}) {
  return new Promise((resolveRun) => {
    const child = execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      resolveRun({
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error ? error.message : "",
      });
    });
    child.on("error", (error) => {
      resolveRun({ ok: false, stdout: "", stderr: "", error: error.message });
    });
  });
}

function createInstallTask() {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    status: "queued",
    progress: 0,
    progressLabel: "等待安装",
    statusText: "queued",
    platform: process.platform,
    installMethod: "",
    error: "",
    helpUrl: "",
    logs: [],
    createdAt: now,
    startedAt: "",
    completedAt: "",
    updatedAt: now,
  };
  saveInstallTask(task);
  return task;
}

async function runInstallTask(id) {
  if (!installTask || installTask.id !== id) return;

  updateInstallTask({
    status: "running",
    progress: 4,
    progressLabel: "检查 Ollama",
    statusText: "checking",
    startedAt: new Date().toISOString(),
  });

  try {
    if (await isOllamaServiceOnline()) {
      updateInstallTask({
        status: "succeeded",
        progress: 100,
        progressLabel: "Ollama 服务已在线",
        statusText: "online",
        installMethod: "existing-service",
        completedAt: new Date().toISOString(),
        log: "Ollama API is already responding.",
      });
      return;
    }

    let command = resolveOllamaCommand();
    if (command) {
      updateInstallTask({
        progress: 28,
        progressLabel: "Ollama 已安装，正在启动服务",
        statusText: "starting",
        installMethod: "existing-command",
        log: `Found Ollama command: ${command}`,
      });
    } else {
      await installOllamaForPlatform();
      command = resolveOllamaCommand();
      if (!command) {
        throw installError("Ollama installed, but the command was not found on PATH. Restart the terminal or install from https://ollama.com/download.", "https://ollama.com/download");
      }
    }

    await startOllamaService(command);
    updateInstallTask({
      status: "succeeded",
      progress: 100,
      progressLabel: "Ollama 已安装并启动",
      statusText: "success",
      completedAt: new Date().toISOString(),
      log: "Ollama API is ready at http://127.0.0.1:11434.",
    });
  } catch (error) {
    updateInstallTask({
      status: "failed",
      progressLabel: "安装失败",
      statusText: "failed",
      error: error.message,
      helpUrl: error.helpUrl || manualInstallUrl(),
      completedAt: new Date().toISOString(),
      log: error.message,
    });
  }
}

async function installOllamaForPlatform() {
  if (process.platform === "darwin") {
    if (!isCommandAvailable("brew")) {
      throw installError("Homebrew is not installed. Install Ollama manually from https://ollama.com/download/mac, or install Homebrew and retry.", "https://ollama.com/download/mac");
    }
    updateInstallTask({
      progress: 18,
      progressLabel: "使用 Homebrew 安装 Ollama",
      statusText: "brew install ollama",
      installMethod: "homebrew",
      log: "Running: brew install ollama",
    });
    const result = await runCommand("brew", ["install", "ollama"], { timeoutMs: 1000 * 60 * 20 });
    appendInstallOutput(result.stdout);
    appendInstallOutput(result.stderr);
    if (!result.ok) throw installError(result.error || result.stderr || "brew install ollama failed.", "https://ollama.com/download/mac");
    updateInstallTask({ progress: 62, progressLabel: "Homebrew 安装完成", statusText: "installed" });
    return;
  }

  if (process.platform === "win32") {
    if (!isCommandAvailable("winget")) {
      throw installError("winget is not available. Install Ollama manually from https://ollama.com/download/windows, then retry.", "https://ollama.com/download/windows");
    }
    updateInstallTask({
      progress: 18,
      progressLabel: "使用 winget 安装 Ollama",
      statusText: "winget install Ollama.Ollama",
      installMethod: "winget",
      log: "Running: winget install --id Ollama.Ollama",
    });
    const result = await runCommand("winget", [
      "install",
      "--id",
      "Ollama.Ollama",
      "--source",
      "winget",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ], { timeoutMs: 1000 * 60 * 20 });
    appendInstallOutput(result.stdout);
    appendInstallOutput(result.stderr);
    if (!result.ok) throw installError(result.error || result.stderr || "winget install Ollama.Ollama failed.", "https://ollama.com/download/windows");
    updateInstallTask({ progress: 62, progressLabel: "winget 安装完成", statusText: "installed" });
    return;
  }

  throw installError("This one-click installer currently supports macOS and Windows only. Install Ollama manually from https://ollama.com/download.", "https://ollama.com/download");
}

async function startOllamaService(command) {
  if (await isOllamaServiceOnline()) return;
  updateInstallTask({
    progress: Math.max(Number(installTask?.progress || 0), 72),
    progressLabel: "启动 Ollama 服务",
    statusText: "ollama serve",
    log: `Starting: ${command} serve`,
  });

  try {
    const child = spawn(command, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    throw installError(`Failed to start Ollama service: ${error.message}`, manualInstallUrl());
  }

  const ready = await waitForOllamaService();
  if (!ready) {
    throw installError("Ollama service did not respond at http://127.0.0.1:11434 within 45 seconds.", manualInstallUrl());
  }
}

async function isOllamaServiceOnline() {
  return Boolean(await fetchJsonSafe("http://127.0.0.1:11434/api/version"));
}

async function waitForOllamaService({ timeoutMs = 45000, intervalMs = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isOllamaServiceOnline()) return true;
    const elapsed = Date.now() - started;
    const progress = 72 + Math.min(22, Math.round((elapsed / timeoutMs) * 22));
    updateInstallTask({
      progress,
      progressLabel: "等待 Ollama 服务响应",
      statusText: "waiting",
    });
    await sleep(intervalMs);
  }
  return false;
}

function updateInstallTask(patch = {}) {
  if (!installTask) return null;
  const logs = [...(installTask.logs || [])];
  if (patch.log && logs[logs.length - 1] !== patch.log) logs.push(patch.log);
  installTask = {
    ...installTask,
    ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => key !== "log" && value !== undefined)),
    logs: logs.slice(-30),
    updatedAt: new Date().toISOString(),
  };
  saveInstallTask(installTask);
  return sanitizeInstallTask(installTask);
}

function appendInstallOutput(output = "") {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(-8)) updateInstallTask({ log: line, statusText: line });
}

function sanitizeInstallTask(task = {}) {
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    progressLabel: task.progressLabel,
    statusText: task.statusText,
    platform: task.platform,
    installMethod: task.installMethod,
    error: task.error,
    helpUrl: task.helpUrl,
    logs: task.logs || [],
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
}

function loadInstallTask() {
  try {
    const parsed = JSON.parse(readFileSync(installTaskPath, "utf8"));
    return normalizeLoadedInstallTask(parsed?.task || parsed);
  } catch {
    return null;
  }
}

function normalizeLoadedInstallTask(task = {}) {
  if (!task.id) return null;
  const wasRunning = ["queued", "running"].includes(task.status);
  return {
    ...task,
    status: wasRunning ? "failed" : task.status || "failed",
    error: wasRunning ? "Backend restarted while installing Ollama. Please start the install again." : task.error || "",
    progressLabel: wasRunning ? "安装中断" : task.progressLabel || "",
    completedAt: task.completedAt || (wasRunning ? new Date().toISOString() : ""),
  };
}

function saveInstallTask(task) {
  try {
    writeFileSync(installTaskPath, JSON.stringify({ task: sanitizeInstallTask(task) }, null, 2));
  } catch {
    // Installer status is best-effort; the running task remains available in memory.
  }
}

function installError(message, helpUrl = "") {
  const error = new Error(message);
  error.helpUrl = helpUrl;
  return error;
}

function manualInstallUrl() {
  if (process.platform === "darwin") return "https://ollama.com/download/mac";
  if (process.platform === "win32") return "https://ollama.com/download/windows";
  return "https://ollama.com/download";
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function createPullTask(model, preflight) {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    model,
    status: "queued",
    progress: 0,
    progressLabel: "等待下载",
    statusText: "queued",
    completed: 0,
    total: 0,
    error: "",
    logs: [],
    preflight,
    createdAt: now,
    startedAt: "",
    completedAt: "",
    updatedAt: now,
  };
  pullTasks.set(task.id, task);
  savePullTasks();
  return sanitizePullTask(task);
}

async function runPullTask(id) {
  const task = pullTasks.get(id);
  if (!task) return;

  updatePullTask(id, {
    status: "running",
    progress: 1,
    progressLabel: "连接 Ollama",
    statusText: "starting",
    startedAt: new Date().toISOString(),
  });

  try {
    const response = await fetch("http://127.0.0.1:11434/api/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: task.model, stream: true }),
    });
    if (!response.ok) throw new Error(`Ollama pull failed: ${response.status}`);
    if (!response.body) throw new Error("Ollama pull did not return a stream.");

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        handlePullLine(id, line);
      }
    }
    if (buffer.trim()) handlePullLine(id, buffer);

    const latest = pullTasks.get(id);
    if (latest && latest.status !== "failed") {
      updatePullTask(id, {
        status: "succeeded",
        progress: 100,
        progressLabel: "下载完成",
        statusText: "success",
        completedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    updatePullTask(id, {
      status: "failed",
      error: error.message,
      progressLabel: "下载失败",
      completedAt: new Date().toISOString(),
    });
  }
}

function handlePullLine(id, line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    appendPullLog(id, line);
    return;
  }

  if (event.error) {
    updatePullTask(id, {
      status: "failed",
      error: event.error,
      progressLabel: "下载失败",
      statusText: event.status || "failed",
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const completed = Number(event.completed || 0);
  const total = Number(event.total || 0);
  const progress = total > 0 ? Math.max(1, Math.min(99, Math.round((completed / total) * 100))) : undefined;
  const statusText = event.status || "";
  updatePullTask(id, {
    statusText,
    completed,
    total,
    progress: progress ?? undefined,
    progressLabel: buildPullProgressLabel(statusText, completed, total),
    log: statusText,
  });
}

function updatePullTask(id, patch = {}) {
  const task = pullTasks.get(id);
  if (!task) return null;
  const logs = [...(task.logs || [])];
  if (patch.log && logs[logs.length - 1] !== patch.log) logs.push(patch.log);
  const next = {
    ...task,
    ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => key !== "log" && value !== undefined)),
    logs: logs.slice(-20),
    updatedAt: new Date().toISOString(),
  };
  pullTasks.set(id, next);
  savePullTasks();
  return sanitizePullTask(next);
}

function appendPullLog(id, text) {
  updatePullTask(id, { log: text, statusText: text, progressLabel: text });
}

function buildPullProgressLabel(status, completed, total) {
  if (total > 0) return `${status || "下载中"} · ${formatBytes(completed)} / ${formatBytes(total)}`;
  return status || "下载中";
}

function sanitizePullTask(task) {
  return {
    id: task.id,
    model: task.model,
    status: task.status,
    progress: task.progress,
    progressLabel: task.progressLabel,
    statusText: task.statusText,
    completed: task.completed,
    total: task.total,
    error: task.error,
    logs: task.logs || [],
    preflight: task.preflight,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
}

function loadPullTasks() {
  try {
    const parsed = JSON.parse(readFileSync(pullTasksPath, "utf8"));
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    return new Map(tasks.map((task) => [task.id, normalizeLoadedPullTask(task)]));
  } catch {
    return new Map();
  }
}

function normalizeLoadedPullTask(task = {}) {
  const staleStatus = ["queued", "running"].includes(task.status) ? "failed" : task.status;
  return {
    ...task,
    status: staleStatus || "failed",
    error: staleStatus === "failed" && ["queued", "running"].includes(task.status) ? "Backend restarted while pulling. Please start the download again." : task.error || "",
    progressLabel: staleStatus === "failed" && ["queued", "running"].includes(task.status) ? "下载中断" : task.progressLabel || "",
    completedAt: task.completedAt || (staleStatus === "failed" ? new Date().toISOString() : ""),
  };
}

function savePullTasks() {
  try {
    writeFileSync(pullTasksPath, JSON.stringify({ tasks: listLocalLlmPullTasks({ limit: 50 }) }, null, 2));
  } catch {
    // Progress persistence is best-effort; the running task remains available in memory.
  }
}

function fallbackLibraryModels(query = "") {
  const common = [
    "gemma4:e4b",
    "llama3.2",
    "llama3.1",
    "qwen3",
    "qwen2.5",
    "qwen2.5-coder",
    "mistral",
    "deepseek-r1",
    "phi4",
  ];
  const needle = query.toLowerCase();
  return common
    .filter((name) => !needle || name.toLowerCase().includes(needle) || needle.length < 2)
    .map((name) => ({ name, pullName: name, url: `https://ollama.com/library/${name.split(":")[0]}` }));
}

function normalizeInstalledModel(model = {}) {
  const sizeBytes = Number(model.size || 0);
  return {
    name: model.name || "",
    model: model.model || model.name || "",
    digest: model.digest || "",
    size: sizeBytes,
    sizeLabel: sizeBytes ? formatBytes(sizeBytes) : "",
    modifiedAt: model.modified_at || model.modifiedAt || "",
    details: model.details || {},
  };
}

function parseOllamaTags(html, baseName) {
  const tags = new Map();
  const linkPattern = new RegExp(`<a\\s+href="/library/(${escapeRegExp(baseName)}:[^"]+)"[\\s\\S]*?</a>`, "gi");

  for (const match of html.matchAll(linkPattern)) {
    const name = decodeHtml(match[1]);
    if (!name || tags.has(name)) continue;
    const start = match.index || 0;
    const end = findNextTagLink(html, baseName, start + match[0].length);
    const row = html.slice(start, end > start ? end : Math.min(html.length, start + 2200));
    const rowText = normalizeWhitespace(stripHtml(row));
    const size = parseSizeLabel(rowText);
    const context = parseContextLabel(rowText);
    tags.set(name, {
      name,
      sizeGb: size.sizeGb,
      sizeLabel: size.sizeLabel,
      context,
      family: rowText.includes("Vision") ? "Vision" : rowText.includes("Embedding") ? "Embedding" : "Text",
      url: `https://ollama.com/library/${name}`,
    });
  }

  if (!tags.size) {
    const tagPattern = new RegExp(`${escapeRegExp(baseName)}:[a-zA-Z0-9._-]+`, "g");
    for (const match of html.matchAll(tagPattern)) {
      const name = match[0];
      if (tags.has(name)) continue;
      const nearby = html.slice(Math.max(0, match.index - 120), Math.min(html.length, match.index + 800));
      const rowText = normalizeWhitespace(stripHtml(nearby));
      const size = parseSizeLabel(rowText);
      tags.set(name, {
        name,
        sizeGb: size.sizeGb,
        sizeLabel: size.sizeLabel,
        context: parseContextLabel(rowText),
        family: rowText.includes("Vision") ? "Vision" : rowText.includes("Embedding") ? "Embedding" : "Text",
        url: `https://ollama.com/library/${name}`,
      });
    }
  }
  return [...tags.values()].sort((a, b) => (a.sizeGb || Number.MAX_SAFE_INTEGER) - (b.sizeGb || Number.MAX_SAFE_INTEGER));
}

function chooseModelTag(model, tags) {
  if (!tags.length) return null;
  if (model.includes(":")) {
    const exact = tags.find((tag) => tag.name === model);
    if (exact) return exact;
  } else {
    const latest = tags.find((tag) => tag.name === `${model}:latest`);
    if (latest) return latest;
  }
  return tags.find((tag) => tag.sizeGb > 0) || tags[0];
}

async function getHardwareProfile() {
  const [gpu, memory] = await Promise.all([
    runCommand("nvidia-smi", ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"], { timeoutMs: 5000 }),
    getSystemMemory(),
  ]);
  const firstGpu = gpu.ok ? gpu.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "" : "";
  const [gpuName = "", total = "", free = ""] = firstGpu.split(",").map((part) => part.trim());
  return {
    gpuName,
    gpuMemoryGb: Number(total) ? Math.round(Number(total) / 1024) : 0,
    gpuFreeGb: Number(free) ? Math.round(Number(free) / 1024) : 0,
    systemMemoryGb: memory,
  };
}

async function getSystemMemory() {
  if (process.platform !== "win32") return 0;
  const result = await runCommand("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"], { timeoutMs: 5000 });
  const bytes = Number(String(result.stdout || "").trim());
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024 / 1024) : 0;
}

function estimateModelFit(model, sizeGb = 0, hardware = {}) {
  const paramMatch = String(model || "").match(/([0-9]+(?:\.[0-9]+)?)\s*b/i);
  const paramsB = paramMatch ? Number(paramMatch[1]) : 0;
  const estimatedSize = sizeGb || estimateSizeFromParams(paramsB);
  const availableGpu = Number(hardware.gpuFreeGb || hardware.gpuMemoryGb || 0);
  const systemMemory = Number(hardware.systemMemoryGb || 0);

  if (!estimatedSize) {
    return { level: "unknown", label: "无法静态判断", reason: "未获取到模型大小，建议先查看模型页或选择较小 tag。" };
  }
  if (availableGpu && estimatedSize <= availableGpu * 0.75) {
    return { level: "good", label: "预计可运行", reason: `模型约 ${formatGb(estimatedSize)}，当前可用显存约 ${availableGpu}GB。` };
  }
  if ((hardware.gpuMemoryGb && estimatedSize <= hardware.gpuMemoryGb * 0.9) || (systemMemory && estimatedSize <= systemMemory * 0.5)) {
    return { level: "warning", label: "可能可运行但会占用较高资源", reason: `模型约 ${formatGb(estimatedSize)}，可能需要释放 A1111 或启用省显存模式。` };
  }
  return { level: "danger", label: "不建议拉取/运行", reason: `模型约 ${formatGb(estimatedSize)}，超过当前机器舒适范围。` };
}

function estimateSizeFromParams(paramsB) {
  if (!paramsB) return 0;
  return Math.round(paramsB * 0.65 * 10) / 10;
}

function formatGb(value) {
  return `${Math.round(Number(value) * 10) / 10}GB`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 || unitIndex < 2 ? 0 : 1;
  return `${size.toFixed(precision)}${units[unitIndex]}`;
}

function findNextTagLink(html, baseName, fromIndex) {
  const next = html.slice(fromIndex).search(new RegExp(`<a\\s+href="/library/${escapeRegExp(baseName)}:`, "i"));
  return next >= 0 ? fromIndex + next : -1;
}

function stripHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSizeLabel(text) {
  const match = String(text || "").match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)\b/i);
  if (!match) return { sizeGb: 0, sizeLabel: "" };
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const sizeGb = unit === "TB" ? value * 1024 : unit === "MB" ? value / 1024 : value;
  return {
    sizeGb: Math.round(sizeGb * 100) / 100,
    sizeLabel: `${match[1]}${unit}`,
  };
}

function parseContextLabel(text) {
  const match = String(text || "").match(/([0-9]+(?:\.[0-9]+)?\s*[KM]?)\s*context/i);
  return match ? match[1].replace(/\s+/g, "") : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
