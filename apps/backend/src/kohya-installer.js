import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = join(projectRoot, "data");
const installTaskPath = join(dataDir, "kohya-install.json");
const defaultInstallDir = join(projectRoot, "vendor", "engines", "kohya_ss");
const repoUrl = "https://github.com/bmaltais/kohya_ss.git";
const repoArchiveUrl = "https://codeload.github.com/bmaltais/kohya_ss/zip/refs/heads/master";
const sdScriptsArchiveUrl = "https://codeload.github.com/kohya-ss/sd-scripts/zip/refs/heads/main";
const envKey = "KOHYA_SS_PATH";
const trainScriptCandidates = [
  "sd-scripts/train_network.py",
  "train_network.py",
  "sdxl_train_network.py",
  "sd-scripts/sdxl_train_network.py",
];
mkdirSync(dataDir, { recursive: true });

let installTask = loadInstallTask();

export async function getKohyaStatus() {
  const envPath = resolveOptionalPath(process.env.KOHYA_SS_PATH || "");
  const bundledPath = defaultInstallDir;
  const detectedPath = resolveKohyaPath();
  const trainScript = detectedPath ? resolveKohyaTrainScript(detectedPath) : "";
  const installed = Boolean(detectedPath && trainScript);
  const [git, python, uv, repo] = await Promise.all([
    commandVersion(resolveGitCommand(), ["--version"]),
    commandVersion(resolvePythonCommand(), ["--version"]),
    commandVersion(resolveUvCommand(), ["--version"]),
    readRepoInfo(detectedPath || bundledPath),
  ]);

  return {
    runtime: "kohya_ss",
    installed,
    ready: installed,
    configuredPath: envPath,
    bundledPath,
    detectedPath: detectedPath || (existsSync(bundledPath) ? bundledPath : ""),
    trainScript,
    repoUrl,
    repo,
    setupScript: detectedPath && existsSync(join(detectedPath, "setup.sh")) ? join(detectedPath, "setup.sh") : "",
    venvPath: detectedPath ? join(detectedPath, ".venv") : join(bundledPath, ".venv"),
    envLine: `${envKey}=${relativeToRoot(bundledPath)}`,
    commands: {
      git,
      python,
      uv,
    },
    error: installed ? "" : buildStatusError(envPath, bundledPath, git, python),
  };
}

export function getKohyaInstallTask() {
  return installTask ? sanitizeInstallTask(installTask) : null;
}

export async function installKohyaRuntime() {
  if (installTask && ["queued", "running"].includes(installTask.status)) {
    return { ok: true, task: sanitizeInstallTask(installTask) };
  }

  installTask = createInstallTask();
  void runInstallTask(installTask.id);
  return { ok: true, task: sanitizeInstallTask(installTask) };
}

export function resolveKohyaPath() {
  const candidates = [
    process.env.KOHYA_SS_PATH,
    defaultInstallDir,
  ].map(resolveOptionalPath).filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (resolveKohyaTrainScript(candidate)) return candidate;
  }

  return "";
}

export function resolveKohyaTrainScript(kohyaPath = resolveKohyaPath()) {
  const root = resolveOptionalPath(kohyaPath);
  if (!root || !existsSync(root)) return "";
  for (const candidate of trainScriptCandidates) {
    const file = join(root, candidate);
    if (existsSync(file)) return file;
  }
  return "";
}

export function resolveKohyaPythonCommand(kohyaPath = resolveKohyaPath()) {
  const root = resolveOptionalPath(kohyaPath);
  if (root) {
    const venvPython = venvPythonPath(join(root, ".venv"));
    if (existsSync(venvPython)) return venvPython;
  }
  return resolvePythonCommand() || process.env.PYTHON || "python";
}

function createInstallTask() {
  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    status: "queued",
    progress: 0,
    progressLabel: "等待安装 kohya_ss",
    statusText: "queued",
    platform: process.platform,
    installMethod: "git+uv",
    installDir: defaultInstallDir,
    repoUrl,
    error: "",
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
    progress: 3,
    progressLabel: "检查安装环境",
    statusText: "checking",
    startedAt: new Date().toISOString(),
  });

  try {
    const git = resolveGitCommand();
    const python = resolvePythonCommand();
    if (!git) throw installError("未找到 git。请先安装 git 后重试。");
    if (!python) throw installError("未找到 python3。请先安装 Python 3.10+ 后重试。");

    await ensureRepository(git);
    await ensurePythonEnvironment(python);
    await ensureEnvFile(defaultInstallDir);
    process.env.KOHYA_SS_PATH = defaultInstallDir;

    const trainScript = resolveKohyaTrainScript(defaultInstallDir);
    if (!trainScript) {
      throw installError("kohya_ss 已下载，但未找到 train_network.py。请检查仓库是否完整。");
    }

    updateInstallTask({
      status: "succeeded",
      progress: 100,
      progressLabel: "kohya_ss 已就绪",
      statusText: "success",
      completedAt: new Date().toISOString(),
      log: `Training script: ${trainScript}`,
    });
  } catch (error) {
    updateInstallTask({
      status: "failed",
      progressLabel: "安装失败",
      statusText: "failed",
      error: error.message,
      completedAt: new Date().toISOString(),
      log: error.message,
    });
  }
}

async function ensureRepository(git) {
  mkdirSync(dirname(defaultInstallDir), { recursive: true });

  if (existsSync(join(defaultInstallDir, ".git"))) {
    updateInstallTask({
      progress: 18,
      progressLabel: "更新 kohya_ss 仓库",
      statusText: "git pull",
      log: `Using existing repo: ${defaultInstallDir}`,
    });
    await runStep(git, ["-C", defaultInstallDir, "fetch", "--depth", "1", "origin"], { timeoutMs: 1000 * 60 * 10 });
    await runStep(git, ["-C", defaultInstallDir, "pull", "--ff-only"], { timeoutMs: 1000 * 60 * 10, optional: true });
    await runStep(git, ["-C", defaultInstallDir, "submodule", "update", "--init", "--recursive", "--depth", "1"], { timeoutMs: 1000 * 60 * 15, optional: true });
    return;
  }

  if (existsSync(defaultInstallDir)) {
    const entries = await readdir(defaultInstallDir).catch(() => []);
    if (resolveKohyaTrainScript(defaultInstallDir)) {
      updateInstallTask({
        progress: 34,
        progressLabel: "复用已下载的 kohya_ss",
        statusText: "existing archive install",
        log: `Found training script in ${defaultInstallDir}`,
      });
      return;
    }
    if (entries.length) throw installError(`${defaultInstallDir} 已存在但不是 git 仓库。请移走该目录后重试。`);
    rmSync(defaultInstallDir, { recursive: true, force: true });
  }

  updateInstallTask({
    progress: 12,
    progressLabel: "下载 kohya_ss",
    statusText: "git clone",
    log: `Cloning ${repoUrl}`,
  });

  try {
    await runStep(git, [
      "-c", "http.version=HTTP/1.1",
      "clone",
      "--recursive",
      "--depth", "1",
      repoUrl,
      defaultInstallDir,
    ], { timeoutMs: 1000 * 60 * 30 });
  } catch (error) {
    updateInstallTask({
      progress: 18,
      progressLabel: "Git 下载失败，改用 ZIP 安装",
      statusText: "zip fallback",
      log: error.message,
    });
    await installRepositoryFromArchives();
    return;
  }

  updateInstallTask({
    progress: 34,
    progressLabel: "初始化子模块",
    statusText: "git submodule",
  });
  await runStep(git, ["-C", defaultInstallDir, "submodule", "update", "--init", "--recursive", "--depth", "1"], { timeoutMs: 1000 * 60 * 20, optional: true });
  if (!resolveKohyaTrainScript(defaultInstallDir)) {
    updateInstallTask({
      progress: 40,
      progressLabel: "子模块未完整，改用 ZIP 补齐",
      statusText: "sd-scripts zip fallback",
    });
    await installSdScriptsFromArchive();
  }
}

async function installRepositoryFromArchives() {
  const tmpRoot = join(projectRoot, "tmp", "kohya-install");
  const repoZip = join(tmpRoot, "kohya_ss.zip");
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });

  updateInstallTask({
    progress: 24,
    progressLabel: "下载 kohya_ss ZIP",
    statusText: "download archive",
    log: repoArchiveUrl,
  });
  await downloadFile(repoArchiveUrl, repoZip);

  updateInstallTask({
    progress: 32,
    progressLabel: "解压 kohya_ss",
    statusText: "unzip archive",
  });
  await runStep("unzip", ["-q", repoZip, "-d", tmpRoot], { timeoutMs: 1000 * 60 * 5 });
  const extracted = await firstDirectory(tmpRoot, "bmaltais-kohya_ss-");
  if (!extracted) throw installError("kohya_ss ZIP 解压后未找到项目目录。");

  rmSync(defaultInstallDir, { recursive: true, force: true });
  mkdirSync(dirname(defaultInstallDir), { recursive: true });
  await runStep("ditto", [extracted, defaultInstallDir], { timeoutMs: 1000 * 60 * 5 });
  await installSdScriptsFromArchive();
}

async function installSdScriptsFromArchive() {
  const tmpRoot = join(projectRoot, "tmp", "kohya-install-sd-scripts");
  const repoZip = join(tmpRoot, "sd-scripts.zip");
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });

  updateInstallTask({
    progress: 38,
    progressLabel: "下载 sd-scripts ZIP",
    statusText: "download sd-scripts",
    log: sdScriptsArchiveUrl,
  });
  await downloadFile(sdScriptsArchiveUrl, repoZip);

  updateInstallTask({
    progress: 44,
    progressLabel: "解压 sd-scripts",
    statusText: "unzip sd-scripts",
  });
  await runStep("unzip", ["-q", repoZip, "-d", tmpRoot], { timeoutMs: 1000 * 60 * 5 });
  const extracted = await firstDirectory(tmpRoot, "sd-scripts-");
  if (!extracted) throw installError("sd-scripts ZIP 解压后未找到项目目录。");

  const target = join(defaultInstallDir, "sd-scripts");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  await runStep("ditto", [extracted, target], { timeoutMs: 1000 * 60 * 5 });
}

async function downloadFile(url, target) {
  const curl = resolveCommand("curl");
  if (curl) {
    await runStep(curl, [
      "-L",
      "--fail",
      "--connect-timeout", "20",
      "--max-time", "600",
      "--retry", "5",
      "--retry-all-errors",
      "--retry-delay", "3",
      "-o", target,
      url,
    ], { timeoutMs: 1000 * 60 * 12 });
    return;
  }

  const response = await fetch(url, {
    headers: { "User-Agent": "MuseForge-Studio kohya installer" },
    signal: AbortSignal.timeout(1000 * 60 * 10),
  });
  if (!response.ok || !response.body) {
    throw installError(`下载失败：${url} (${response.status})`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    total += buffer.length;
    if (total % (1024 * 1024 * 2) < buffer.length) {
      updateInstallTask({ log: `Downloaded ${formatBytes(total)}` });
    }
  }
  await writeFile(target, Buffer.concat(chunks));
}

async function firstDirectory(root, prefix) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const entry = entries.find((item) => item.isDirectory() && item.name.startsWith(prefix));
  return entry ? join(root, entry.name) : "";
}

async function ensurePythonEnvironment(python) {
  const uv = resolveUvCommand();
  const venvPath = join(defaultInstallDir, ".venv");
  const requirements = await chooseRequirementsFile();
  const installRequirements = requirements ? await prepareRequirementsFile(requirements) : "";
  const installCommand = uv || python;

  if (uv) {
    updateInstallTask({
      progress: 48,
      progressLabel: "创建 kohya_ss 虚拟环境",
      statusText: "uv venv",
      log: `Creating venv: ${venvPath}`,
    });
    await runStep(uv, ["venv", venvPath, "--python", python, "--clear"], { cwd: defaultInstallDir, timeoutMs: 1000 * 60 * 10 });
  } else {
    updateInstallTask({
      progress: 48,
      progressLabel: "创建 kohya_ss 虚拟环境",
      statusText: "python -m venv",
      log: `Creating venv: ${venvPath}`,
    });
    await runStep(python, ["-m", "venv", venvPath], { cwd: defaultInstallDir, timeoutMs: 1000 * 60 * 10 });
  }

  if (!installRequirements) {
    updateInstallTask({
      progress: 78,
      progressLabel: "未找到 requirements，跳过依赖安装",
      statusText: "no requirements",
    });
    return;
  }

  updateInstallTask({
      progress: 62,
      progressLabel: "安装 kohya_ss Python 依赖",
      statusText: `install ${relativeToRoot(installRequirements)}`,
      log: `Installing requirements: ${installRequirements}`,
    });

  if (uv) {
    await runStep(installCommand, ["pip", "install", "--index-strategy", "unsafe-best-match", "-r", installRequirements, "--python", venvPath], {
      cwd: defaultInstallDir,
      timeoutMs: 1000 * 60 * 40,
      env: installEnv(),
    });
  } else {
    await runStep(venvPythonPath(venvPath), ["-m", "pip", "install", "-r", installRequirements], {
      cwd: defaultInstallDir,
      timeoutMs: 1000 * 60 * 40,
      env: installEnv(),
    });
  }

  updateInstallTask({
    progress: 88,
    progressLabel: "依赖安装完成",
    statusText: "requirements installed",
  });
}

async function prepareRequirementsFile(requirements) {
  if (!(process.platform === "darwin" && process.arch === "arm64")) return requirements;
  const cleaned = [
    "torch==2.7.1",
    "torchvision==0.22.1",
    "accelerate==1.6.0",
    "transformers==4.54.1",
    "diffusers[torch]==0.32.1",
    "ftfy==6.3.1",
    "opencv-python==4.10.0.84",
    "einops==0.7.0",
    "lion-pytorch==0.2.3",
    "schedulefree==1.4",
    "pytorch-optimizer==3.10.0",
    "prodigy-plus-schedule-free==1.9.2",
    "prodigyopt==1.1.2",
    "tensorboard",
    "safetensors==0.4.5",
    "toml==0.10.2",
    "voluptuous==0.15.2",
    "huggingface-hub==0.34.3",
    "imagesize==1.4.1",
    "numpy",
    "rich==14.1.0",
    "sentencepiece==0.2.1",
    "-e ./sd-scripts",
    "",
  ];
  const target = join(defaultInstallDir, "requirements_macos_arm64_museforge.txt");
  mkdirSync(dirname(target), { recursive: true });
  await writeFile(target, cleaned.join("\n"), "utf8");
  updateInstallTask({
    log: "Apple Silicon 轻量依赖：使用 PyTorch stable，跳过 bitsandbytes/xformers/TensorFlow。",
    statusText: "filtered macOS requirements",
  });
  return target;
}

async function chooseRequirementsFile() {
  const platformSpecific = process.platform === "darwin"
    ? [process.arch === "arm64" ? "requirements_macos_arm64.txt" : "requirements_macos_amd64.txt", "requirements_macos.txt", "requirements_mac.txt", "requirements.txt"]
    : process.platform === "win32"
      ? ["requirements_windows.txt", "requirements.txt"]
      : ["requirements_linux.txt", "requirements.txt"];
  for (const filename of platformSpecific) {
    const file = join(defaultInstallDir, filename);
    if (existsSync(file)) return file;
  }
  return "";
}

async function ensureEnvFile(kohyaPath) {
  const envPath = join(projectRoot, ".env");
  const value = relativeToRoot(kohyaPath);
  let current = "";
  if (existsSync(envPath)) current = await readFile(envPath, "utf8");

  const lines = current ? current.split(/\r?\n/) : [];
  let found = false;
  const next = lines.map((line) => {
    if (!line.match(/^\s*KOHYA_SS_PATH\s*=/)) return line;
    found = true;
    return `KOHYA_SS_PATH=${value}`;
  });

  if (!found) {
    if (next.length && next[next.length - 1].trim()) next.push("");
    next.push("# LoRA trainer runtime");
    next.push(`KOHYA_SS_PATH=${value}`);
  }

  await writeFile(envPath, `${next.join("\n").replace(/\n+$/g, "")}\n`, "utf8");
  updateInstallTask({
    progress: 94,
    progressLabel: "已写入 KOHYA_SS_PATH",
    statusText: "env configured",
    log: `KOHYA_SS_PATH=${value}`,
  });
}

function runStep(command, args = [], { cwd = projectRoot, timeoutMs = 10000, env = process.env, optional = false } = {}) {
  return new Promise((resolveStep, rejectStep) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      const error = installError(`${command} ${args.join(" ")} timed out.`);
      if (optional) resolveStep({ ok: false, error: error.message });
      else rejectStep(error);
    }, timeoutMs);

    const record = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        appendInstallOutput(line);
      }
    };

    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (optional) resolveStep({ ok: false, error: error.message });
      else rejectStep(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 || optional) resolveStep({ ok: code === 0, code });
      else rejectStep(installError(`${command} ${args.join(" ")} failed with exit code ${code}.`));
    });
  });
}

function commandVersion(command, args) {
  if (!command) return Promise.resolve({ available: false, path: "", version: "", error: "not found" });
  return new Promise((resolveVersion) => {
    const child = execFile(command, args, { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      resolveVersion({
        available: !error,
        path: command,
        version: String(stdout || stderr || "").trim().split(/\r?\n/)[0] || "",
        error: error ? error.message : "",
      });
    });
    child.on("error", (error) => {
      resolveVersion({ available: false, path: command, version: "", error: error.message });
    });
  });
}

async function readRepoInfo(root) {
  if (!root || !existsSync(join(root, ".git"))) return { present: false, branch: "", commit: "" };
  const git = resolveGitCommand();
  if (!git) return { present: true, branch: "", commit: "" };
  const [branch, commit] = await Promise.all([
    captureCommand(git, ["-C", root, "branch", "--show-current"]),
    captureCommand(git, ["-C", root, "rev-parse", "--short", "HEAD"]),
  ]);
  return {
    present: true,
    branch: branch.stdout.trim(),
    commit: commit.stdout.trim(),
  };
}

function captureCommand(command, args) {
  return new Promise((resolveCapture) => {
    execFile(command, args, { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      resolveCapture({ ok: !error, stdout: stdout || "", stderr: stderr || "", error: error ? error.message : "" });
    });
  });
}

function updateInstallTask(patch = {}) {
  if (!installTask) return null;
  const logs = [...(installTask.logs || [])];
  if (patch.log && logs[logs.length - 1] !== patch.log) logs.push(patch.log);
  installTask = {
    ...installTask,
    ...Object.fromEntries(Object.entries(patch).filter(([key, value]) => key !== "log" && value !== undefined)),
    logs: logs.slice(-80),
    updatedAt: new Date().toISOString(),
  };
  saveInstallTask(installTask);
  return sanitizeInstallTask(installTask);
}

function appendInstallOutput(output = "") {
  const line = String(output || "").trim();
  if (!line) return;
  updateInstallTask({ log: line, statusText: line });
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
    installDir: task.installDir,
    repoUrl: task.repoUrl,
    error: task.error,
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
    error: wasRunning ? "Backend restarted while installing kohya_ss. Please start the install again." : task.error || "",
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

function resolveGitCommand() {
  return resolveCommand("git");
}

function resolveUvCommand() {
  return resolveCommand(process.env.UV_EXE || "uv");
}

function resolvePythonCommand() {
  const candidates = [
    process.env.PYTHON_EXE,
    process.env.PYTHON,
    "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate);
    if (resolved) return resolved;
  }
  return "";
}

function resolveCommand(command = "") {
  const raw = String(command || "").trim();
  if (!raw) return "";
  if (raw.includes("/") || raw.includes("\\")) return existsSync(raw) ? raw : "";
  const pathValue = process.env.PATH || "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${raw}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function resolveOptionalPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return resolve(projectRoot, text);
}

function relativeToRoot(file) {
  const absolute = resolve(file);
  const relative = absolute.startsWith(`${projectRoot}/`) ? absolute.slice(projectRoot.length + 1) : absolute;
  return relative.replace(/\\/g, "/");
}

function installEnv() {
  return {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

function venvPythonPath(venvPath) {
  return process.platform === "win32"
    ? join(venvPath, "Scripts", "python.exe")
    : join(venvPath, "bin", "python");
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function buildStatusError(envPath, bundledPath, git, python) {
  if (!git.available) return "未找到 git，无法自动安装 kohya_ss。";
  if (!python.available) return "未找到 python3，无法创建 kohya_ss 虚拟环境。";
  if (envPath && !existsSync(envPath)) return "KOHYA_SS_PATH 已配置但路径不存在。";
  if (existsSync(bundledPath)) return "已发现 kohya_ss 目录，但还未找到训练脚本。";
  return "未安装 kohya_ss。可在设置页一键安装。";
}

function installError(message) {
  return new Error(message);
}
