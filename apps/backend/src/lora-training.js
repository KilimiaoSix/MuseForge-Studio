import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveKohyaPath, resolveKohyaPythonCommand, resolveKohyaTrainScript } from "./kohya-installer.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const loraRoot = join(projectRoot, "data", "lora-projects");
const manifestPath = join(projectRoot, "engines", "manifest.json");
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const strategyDefaults = Object.freeze({
  stable: { repeats: 8, epochs: 10, learning_rate: "8e-5", network_dim: 32, network_alpha: 16, label: "稳定优先" },
  faithful: { repeats: 10, epochs: 12, learning_rate: "1e-4", network_dim: 64, network_alpha: 32, label: "还原优先" },
  stylized: { repeats: 12, epochs: 14, learning_rate: "1e-4", network_dim: 32, network_alpha: 16, label: "风格化优先" },
});

export async function listLoraProjects() {
  await mkdir(loraRoot, { recursive: true });
  const entries = await readdir(loraRoot, { withFileTypes: true }).catch(() => []);
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const project = await getLoraProject(entry.name).catch(() => null);
    if (project) projects.push(project);
  }
  return projects.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

export async function createLoraProject(input = {}) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const projectName = sanitizeToken(input.projectName || input.project_name || input.name || "new_asset");
  const project = {
    id,
    projectName,
    assetType: normalizeAssetType(input.assetType || input.asset_type),
    assetGoal: String(input.assetGoal || input.asset_goal || "").trim(),
    triggerWord: sanitizeToken(input.triggerWord || input.trigger_word || projectName),
    baseModel: String(input.baseModel || input.base_model || "").trim(),
    strategy: normalizeStrategy(input.strategy || input.simple_strategy),
    status: "draft",
    summary: null,
    trainPlan: null,
    trainedModel: null,
    installedModel: null,
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(loraProjectDir(id, "source"), { recursive: true });
  await mkdir(loraProjectDir(id, "captions"), { recursive: true });
  await mkdir(loraProjectDir(id, "output"), { recursive: true });
  await saveProject(project);
  return enrichProject(project);
}

export async function getLoraProject(id) {
  const project = await readProject(id);
  return enrichProject(project);
}

export async function addLoraProjectAssets(id, input = {}) {
  const project = await readProject(id);
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) throw badRequest("请选择图片或 ZIP 素材。");

  const saved = [];
  await mkdir(loraProjectDir(id, "source"), { recursive: true });
  for (const file of files) {
    const filename = sanitizeFilename(file.filename || file.name || "asset");
    const extension = extname(filename).toLowerCase();
    const parsed = parseDataFile(file.dataUrl || file.data || "");
    if (!parsed) throw badRequest(`${filename} 不是有效的 base64 文件。`);

    if (imageExtensions.has(extension)) {
      const target = await uniqueProjectFile(loraProjectDir(id, "source"), filename);
      await writeFile(target, parsed.buffer);
      saved.push({ filename: basename(target), type: "image", size: parsed.buffer.length });
      continue;
    }

    if (extension === ".zip") {
      const zipPath = await uniqueProjectFile(loraProjectDir(id, "source"), filename);
      await writeFile(zipPath, parsed.buffer);
      const extracted = await extractZip(zipPath, loraProjectDir(id, "source"));
      saved.push({ filename: basename(zipPath), type: "zip", size: parsed.buffer.length, extracted });
      continue;
    }

    throw badRequest(`${filename} 不是支持的素材格式。`);
  }

  project.status = "assets_uploaded";
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  return { project: await getLoraProject(id), saved };
}

export async function inspectLoraProject(id) {
  const project = await readProject(id);
  const images = await listProjectImages(id);
  const hashes = new Map();
  const items = [];

  for (const image of images) {
    const buffer = await readFile(image.path);
    const hash = createHash("sha256").update(buffer).digest("hex");
    const dimensions = readImageDimensions(buffer, extname(image.path).toLowerCase());
    const reasons = [];
    let status = "accepted";

    if (hashes.has(hash)) {
      status = "rejected";
      reasons.push(`重复图片：${hashes.get(hash)}`);
    } else {
      hashes.set(hash, image.filename);
    }
    if (!dimensions.width || !dimensions.height) {
      reasons.push("无法读取分辨率，建议人工确认。");
      status = status === "accepted" ? "needs_review" : status;
    } else if (Math.min(dimensions.width, dimensions.height) < 512) {
      status = "rejected";
      reasons.push("分辨率低于 512，训练效果可能很差。");
    } else if (Math.min(dimensions.width, dimensions.height) < 768) {
      status = status === "accepted" ? "needs_crop" : status;
      reasons.push("分辨率偏低，建议裁剪或补充高清图。");
    }

    items.push({
      filename: image.filename,
      path: image.relativePath,
      size: buffer.length,
      hash,
      width: dimensions.width,
      height: dimensions.height,
      status,
      reasons,
      caption: defaultCaptionFor(project, image.filename),
    });
  }

  const summary = {
    total: items.length,
    accepted: items.filter((item) => item.status === "accepted").length,
    rejected: items.filter((item) => item.status === "rejected").length,
    needsCrop: items.filter((item) => item.status === "needs_crop").length,
    needsReview: items.filter((item) => item.status === "needs_review").length,
    items,
  };

  project.summary = summary;
  project.status = "inspected";
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  await writeDefaultCaptions(id, project, items);
  return { project: await getLoraProject(id), summary };
}

export async function updateLoraCaptions(id, input = {}) {
  const project = await readProject(id);
  const captions = Array.isArray(input.captions) ? input.captions : [];
  await mkdir(loraProjectDir(id, "captions"), { recursive: true });
  const saved = [];
  for (const item of captions) {
    const filename = sanitizeFilename(item.filename || "");
    if (!filename) continue;
    const caption = String(item.caption || "").trim();
    const captionFile = join(loraProjectDir(id, "captions"), `${filename}.txt`);
    await writeFile(captionFile, caption, "utf8");
    saved.push({ filename, caption });
  }
  await writeFile(loraProjectDir(id, "captions.json"), JSON.stringify(saved, null, 2), "utf8");
  project.status = "captioned";
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  return { project: await getLoraProject(id), captions: saved };
}

export async function createLoraTrainingPlan(id, input = {}) {
  const project = await readProject(id);
  const strategy = normalizeStrategy(input.strategy || project.strategy);
  const defaults = strategyDefaults[strategy];
  const plan = {
    project_name: project.projectName,
    asset_type: project.assetType,
    asset_goal: project.assetGoal,
    trigger_word: project.triggerWord,
    simple_strategy: strategy,
    base_model: String(input.baseModel || input.base_model || project.baseModel || "").trim(),
    resolution: numberIn(input.resolution, 512, 2048, 768),
    repeats: numberIn(input.repeats, 1, 80, defaults.repeats),
    epochs: numberIn(input.epochs, 1, 100, defaults.epochs),
    batch_size: numberIn(input.batchSize || input.batch_size, 1, 16, 2),
    learning_rate: String(input.learningRate || input.learning_rate || defaults.learning_rate),
    network_dim: numberIn(input.networkDim || input.network_dim, 4, 256, defaults.network_dim),
    network_alpha: numberIn(input.networkAlpha || input.network_alpha, 1, 256, defaults.network_alpha),
    optimizer: String(input.optimizer || "AdamW"),
    caption_strategy: String(input.captionStrategy || input.caption_strategy || "manual captions + optional cleanup"),
    kohya: {},
  };
  project.trainPlan = plan;
  project.strategy = strategy;
  project.baseModel = plan.base_model;
  project.status = "planned";
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  return { project: await getLoraProject(id), plan };
}

export async function trainLoraProject(id, { signal, update } = {}) {
  const project = await readProject(id);
  const plan = project.trainPlan || (await createLoraTrainingPlan(id)).plan;
  const kohyaPath = resolveKohyaPath();
  if (!kohyaPath || !existsSync(kohyaPath)) {
    throw new Error("kohya_ss 未安装或路径不可用。请到设置 → LoRA 训练器中一键安装后重试。");
  }
  if (!plan.base_model) {
    throw new Error("LoRA 训练需要先选择 base model。");
  }

  await prepareKohyaDataset(id, project, plan);
  const trainScript = resolveKohyaTrainScript(kohyaPath);
  if (!trainScript) {
    throw new Error("未在 kohya_ss 下找到 train_network.py 或 sd-scripts/train_network.py。请在设置中重新检查/安装。");
  }

  const args = buildKohyaArgs(trainScript, id, plan);
  const logs = [];
  const python = resolveKohyaPythonCommand(kohyaPath);
  update?.({ progress: 0.08, progressLabel: "正在启动 kohya_ss", result: { logs, command: `${python} ${args.join(" ")}` } });

  await runStreamingProcess(python, args, {
    cwd: kohyaPath,
    signal,
    logs,
    onData: (line) => {
      const progress = estimateTrainingProgress(line, plan.epochs);
      update?.({
        progress,
        progressLabel: progress >= 0.95 ? "正在保存 LoRA" : "训练中",
        result: { logs: logs.slice(-80) },
      });
    },
  });

  const output = await findLatestSafetensors(loraProjectDir(id, "output"));
  if (!output) throw new Error("训练结束但未找到 .safetensors 输出文件。");

  project.trainedModel = {
    filename: basename(output.path),
    path: output.path,
    size: output.size,
    recommendedWeight: 0.7,
    triggerWord: project.triggerWord,
    promptExample: `${project.triggerWord}, 1girl, anime illustration, best quality`,
    trainedAt: new Date().toISOString(),
  };
  project.status = "trained";
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  return { project: await getLoraProject(id), trainedModel: project.trainedModel, logs: logs.slice(-100) };
}

export async function installLoraProject(id) {
  const project = await readProject(id);
  const source = project.trainedModel?.path;
  if (!source || !existsSync(source)) throw badRequest("还没有可安装的 LoRA 输出文件。");
  const targetDir = await resolveA1111ModelDir("loras");
  await mkdir(targetDir, { recursive: true });
  const destination = await uniqueProjectFile(targetDir, basename(source), true);
  await copyFile(source, destination);
  project.installedModel = {
    filename: basename(destination),
    path: destination,
    installedAt: new Date().toISOString(),
  };
  project.status = "installed";
  project.updatedAt = new Date().toISOString();
  await saveProject(project);
  return { project: await getLoraProject(id), installed: project.installedModel };
}

async function enrichProject(project) {
  const images = await listProjectImages(project.id).catch(() => []);
  const captions = await readCaptions(project.id).catch(() => []);
  return {
    ...project,
    imageCount: images.length,
    captions,
    directories: {
      source: loraProjectDir(project.id, "source"),
      output: loraProjectDir(project.id, "output"),
    },
  };
}

async function readProject(id) {
  const file = loraProjectDir(id, "project.json");
  if (!isPathInside(file, loraRoot)) throw badRequest("项目 ID 不安全。");
  if (!existsSync(file)) throw notFound("LoRA 项目不存在。");
  return JSON.parse(await readFile(file, "utf8"));
}

async function saveProject(project) {
  await mkdir(loraProjectDir(project.id), { recursive: true });
  await writeFile(loraProjectDir(project.id, "project.json"), JSON.stringify(project, null, 2), "utf8");
}

function loraProjectDir(id, ...parts) {
  return join(loraRoot, sanitizeId(id), ...parts);
}

async function listProjectImages(id) {
  const root = loraProjectDir(id, "source");
  const files = await walkFiles(root);
  return files
    .filter((file) => imageExtensions.has(extname(file).toLowerCase()))
    .map((file) => ({
      path: file,
      filename: basename(file),
      relativePath: file.slice(root.length + 1).replace(/\\/g, "/"),
    }));
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const file = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

async function writeDefaultCaptions(id, project, items) {
  const captions = [];
  for (const item of items) {
    const caption = item.caption;
    await writeFile(join(loraProjectDir(id, "captions"), `${item.filename}.txt`), caption, "utf8");
    captions.push({ filename: item.filename, caption });
  }
  await writeFile(loraProjectDir(id, "captions.json"), JSON.stringify(captions, null, 2), "utf8");
}

async function readCaptions(id) {
  const file = loraProjectDir(id, "captions.json");
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, "utf8"));
}

function defaultCaptionFor(project, filename) {
  const stem = basename(filename, extname(filename)).replace(/[-_]+/g, " ");
  return [project.triggerWord, project.assetType, stem].filter(Boolean).join(", ");
}

async function prepareKohyaDataset(id, project, plan) {
  const datasetRoot = loraProjectDir(id, "dataset");
  const trainDir = join(datasetRoot, `${plan.repeats}_${project.triggerWord}`);
  await mkdir(trainDir, { recursive: true });
  const captions = new Map((await readCaptions(id)).map((item) => [item.filename, item.caption]));
  const inspected = project.summary?.items || [];
  const acceptedNames = new Set(inspected.filter((item) => item.status !== "rejected").map((item) => item.filename));
  for (const image of await listProjectImages(id)) {
    if (acceptedNames.size && !acceptedNames.has(image.filename)) continue;
    const targetImage = join(trainDir, image.filename);
    await copyFile(image.path, targetImage);
    await writeFile(`${targetImage}.txt`, captions.get(image.filename) || defaultCaptionFor(project, image.filename), "utf8");
  }
  return { datasetRoot, trainDir };
}

function buildKohyaArgs(trainScript, id, plan) {
  return [
    trainScript,
    "--pretrained_model_name_or_path", plan.base_model,
    "--train_data_dir", loraProjectDir(id, "dataset"),
    "--output_dir", loraProjectDir(id, "output"),
    "--output_name", plan.project_name,
    "--resolution", `${plan.resolution},${plan.resolution}`,
    "--network_module", "networks.lora",
    "--network_dim", String(plan.network_dim),
    "--network_alpha", String(plan.network_alpha),
    "--learning_rate", plan.learning_rate,
    "--optimizer_type", plan.optimizer || "AdamW",
    "--train_batch_size", String(plan.batch_size),
    "--max_train_epochs", String(plan.epochs),
    "--mixed_precision", "fp16",
    "--save_model_as", "safetensors",
    "--caption_extension", ".txt",
  ];
}

async function runStreamingProcess(command, args, { cwd, signal, logs, onData }) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const onAbort = () => {
      child.kill("SIGTERM");
      rejectPromise(new Error("训练已取消。"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const record = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        logs.push(line);
        if (logs.length > 200) logs.splice(0, logs.length - 200);
        onData?.(line);
      }
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`kohya_ss 训练失败，退出码 ${code}。`));
    });
  });
}

function estimateTrainingProgress(line, epochs) {
  const match = String(line).match(/epoch\s+(\d+)\s*\/\s*(\d+)/i);
  if (match) return Math.min(0.95, 0.1 + (Number(match[1]) / Math.max(1, Number(match[2]))) * 0.82);
  const stepMatch = String(line).match(/(\d+)\s*\/\s*(\d+)/);
  if (stepMatch) return Math.min(0.95, 0.1 + (Number(stepMatch[1]) / Math.max(1, Number(stepMatch[2]))) * 0.82);
  if (/saving|save/i.test(line)) return 0.95;
  return Math.min(0.9, 0.1 + (1 / Math.max(1, Number(epochs || 12))) * 0.1);
}

async function findLatestSafetensors(dir) {
  const files = (await readdir(dir).catch(() => []))
    .filter((file) => extname(file).toLowerCase() === ".safetensors")
    .map((file) => join(dir, file));
  let latest = null;
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    if (!latest || info.mtimeMs > latest.mtimeMs) latest = { path: file, size: info.size, mtimeMs: info.mtimeMs };
  }
  return latest;
}

async function resolveA1111ModelDir(key) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const installRoot = resolve(projectRoot, manifest.installDir || "vendor/engines");
  const engine = manifest.engines?.a1111 || {};
  return join(installRoot, engine.directory || "stable-diffusion-webui", engine.modelDirs?.[key] || "models/Lora");
}

async function extractZip(zipPath, outputDir) {
  try {
    await execFileAsync("unzip", ["-oq", zipPath, "-d", outputDir], { timeout: 120000 });
  } catch (error) {
    throw badRequest(`ZIP 解压失败：${error.message}`);
  }
  return (await listProjectImagesFromDir(outputDir)).length;
}

async function listProjectImagesFromDir(dir) {
  return (await walkFiles(dir)).filter((file) => imageExtensions.has(extname(file).toLowerCase()));
}

function parseDataFile(value = "") {
  const match = String(value || "").match(/^data:([^;,]+)?(?:;[^,]+)*;base64,([\s\S]+)$/i);
  if (!match) return null;
  return { mimeType: (match[1] || "application/octet-stream").toLowerCase(), buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64") };
}

function readImageDimensions(buffer, extension) {
  if (extension === ".png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ([".jpg", ".jpeg"].includes(extension)) return readJpegDimensions(buffer);
  if (extension === ".webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF") {
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return { width: 0, height: 0 };
}

async function uniqueProjectFile(targetDir, filename, overwrite = false) {
  const clean = sanitizeFilename(filename);
  const first = join(targetDir, clean);
  if (!isPathInside(first, targetDir)) throw badRequest("文件名不安全。");
  if (overwrite || !existsSync(first)) return first;
  const extension = extname(clean);
  const stem = basename(clean, extension);
  for (let index = 2; index < 1000; index += 1) {
    const candidate = join(targetDir, `${stem}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw badRequest(`无法保存文件：${filename}`);
}

function sanitizeFilename(value = "") {
  const filename = basename(String(value || "").trim());
  if (!filename || filename === "." || filename === "..") throw badRequest("文件名不安全。");
  return filename.replace(/[<>:"|?*\x00-\x1F]/g, "_");
}

function sanitizeToken(value = "") {
  return String(value || "asset").trim().replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "asset";
}

function sanitizeId(value = "") {
  const id = String(value || "").trim();
  if (!/^[a-f0-9-]{10,}$/i.test(id)) throw badRequest("项目 ID 不安全。");
  return id;
}

function normalizeAssetType(value) {
  const type = String(value || "character").trim().toLowerCase();
  return ["character", "style", "meme", "outfit", "prop"].includes(type) ? type : "character";
}

function normalizeStrategy(value) {
  const strategy = String(value || "stable").trim().toLowerCase();
  return strategyDefaults[strategy] ? strategy : "stable";
}

function numberIn(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function isPathInside(file, root) {
  const normalizedFile = resolve(file);
  const normalizedRoot = resolve(root);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`);
}

function badRequest(message) {
  const error = new Error(message);
  error.code = "BAD_REQUEST";
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.code = "NOT_FOUND";
  return error;
}
