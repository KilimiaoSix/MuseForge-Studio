import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadEngineManifest } from "./engines.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const controlNetExtensionRepo = "https://github.com/Mikubill/sd-webui-controlnet.git";
const controlNetExtensionRepoMirrors = [
  controlNetExtensionRepo,
];
const controlNetExtensionZipUrls = [
  "https://github.com/Mikubill/sd-webui-controlnet/archive/refs/heads/main.zip",
  "https://gh.llkk.cc/https://github.com/Mikubill/sd-webui-controlnet/archive/refs/heads/main.zip",
];
const controlNetExtensionDir = "sd-webui-controlnet";

const controlNetPresets = [
  {
    id: "openpose-sd15",
    name: "OpenPose",
    displayName: "照着姿势画",
    filename: "control_v11p_sd15_openpose.pth",
    url: "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_openpose.pth",
    baseType: "sd15",
    controlType: "pose",
    defaultPreprocessor: "openpose_full",
    defaultModule: "openpose_full",
    defaultControlWeight: 0.75,
    purpose: "姿势控制",
  },
  {
    id: "lineart-sd15",
    name: "Lineart",
    displayName: "参考线稿上色",
    filename: "control_v11p_sd15_lineart.pth",
    url: "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_lineart.pth",
    baseType: "sd15",
    controlType: "lineart",
    defaultPreprocessor: "lineart_realistic",
    defaultModule: "lineart_realistic",
    defaultControlWeight: 0.7,
    purpose: "线稿上色",
  },
  {
    id: "depth-sd15",
    name: "Depth",
    displayName: "保持空间和构图",
    filename: "control_v11f1p_sd15_depth.pth",
    url: "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11f1p_sd15_depth.pth",
    baseType: "sd15",
    controlType: "depth",
    defaultPreprocessor: "depth_midas",
    defaultModule: "depth_midas",
    defaultControlWeight: 0.75,
    purpose: "空间构图",
  },
  {
    id: "canny-sd15",
    name: "Canny",
    displayName: "保持轮廓结构",
    filename: "control_v11p_sd15_canny.pth",
    url: "https://huggingface.co/lllyasviel/ControlNet-v1-1/resolve/main/control_v11p_sd15_canny.pth",
    baseType: "sd15",
    controlType: "canny",
    defaultPreprocessor: "canny",
    defaultModule: "canny",
    defaultControlWeight: 0.65,
    purpose: "轮廓结构",
  },
];

export async function listControlNetPresets() {
  const targetDir = await resolveControlNetDir();
  const extension = await getControlNetExtensionStatus();
  return {
    extension,
    presets: controlNetPresets.map((preset) => {
      const path = join(targetDir, preset.filename);
      return { ...preset, installed: existsSync(path), path, installable: true };
    }),
  };
}

export async function getControlNetExtensionStatus() {
  const extensionDir = await resolveControlNetExtensionDir();
  const installed = existsSync(join(extensionDir, "scripts", "controlnet.py"))
    || existsSync(join(extensionDir, "scripts", "external_code.py"));
  const partial = existsSync(extensionDir) && !installed;
  return {
    installed,
    partial,
    path: extensionDir,
    repo: controlNetExtensionRepo,
    restartRequired: false,
  };
}

export async function installControlNetExtension({ signal, update } = {}) {
  const status = await getControlNetExtensionStatus();
  if (status.installed) {
    return { ...status, skipped: true, restartRequired: true };
  }

  update?.({ progress: 0.08, progressLabel: "准备安装 ControlNet 扩展" });
  if (status.partial) {
    update?.({ progress: 0.12, progressLabel: "清理未完成的 ControlNet 扩展安装" });
    await rm(status.path, { recursive: true, force: true });
  }

  await mkdir(resolve(status.path, ".."), { recursive: true });
  let lastError = null;
  for (const [index, repo] of controlNetExtensionRepoMirrors.entries()) {
    update?.({ progress: 0.18 + index * 0.12, progressLabel: index ? "下载 ControlNet 扩展（备用源）" : "下载 ControlNet 扩展" });
    await rm(status.path, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["clone", "--depth", "1", repo, status.path], {
        signal,
        maxBuffer: 1024 * 1024 * 16,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) {
    await installControlNetExtensionFromZip(status.path, {
      signal,
      update,
      startProgress: 0.42,
    }).catch((error) => {
      error.message = `${lastError.message}\nZip fallback failed: ${error.message}`;
      throw error;
    });
  }

  const installed = await getControlNetExtensionStatus();
  if (!installed.installed) {
    throw new Error("ControlNet extension clone completed but extension files were not found.");
  }

  update?.({ progress: 0.95, progressLabel: "ControlNet 扩展安装完成，需要重启 A1111" });
  return {
    ...installed,
    skipped: false,
    restartRequired: true,
  };
}

async function installControlNetExtensionFromZip(destination, { signal, update, startProgress = 0.42 } = {}) {
  const tempRoot = resolve(destination, "..", `.controlnet-download-${Date.now()}`);
  const zipPath = `${tempRoot}.zip`;
  let lastError = null;
  await mkdir(resolve(destination, ".."), { recursive: true });
  for (const [index, url] of controlNetExtensionZipUrls.entries()) {
    update?.({ progress: startProgress + index * 0.12, progressLabel: index ? "下载 ControlNet 扩展压缩包（备用源）" : "下载 ControlNet 扩展压缩包" });
    try {
      await downloadFile(url, zipPath, {
        signal,
        onProgress: (progress) => update?.({
          progress: Math.max(startProgress, Math.min(0.72, startProgress + progress * 0.25)),
          progressLabel: `下载 ControlNet 扩展压缩包 ${Math.round(progress * 100)}%`,
        }),
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await rm(zipPath, { force: true });
    }
  }
  if (lastError) throw lastError;

  update?.({ progress: 0.76, progressLabel: "解压 ControlNet 扩展" });
  await rm(tempRoot, { recursive: true, force: true });
  await execFileAsync("unzip", ["-q", zipPath, "-d", tempRoot], { signal, maxBuffer: 1024 * 1024 * 16 });
  const extracted = resolve(tempRoot, "sd-webui-controlnet-main");
  await rm(destination, { recursive: true, force: true });
  await execFileAsync("mv", [extracted, destination], { signal });
  await rm(tempRoot, { recursive: true, force: true });
  await rm(zipPath, { force: true });
}

export async function installControlNetPreset(id, { signal, update } = {}) {
  const preset = controlNetPresets.find((item) => item.id === id);
  if (!preset) throw badRequest("未知的 ControlNet 预设。");
  const targetDir = await resolveControlNetDir();
  await mkdir(targetDir, { recursive: true });
  const destination = join(targetDir, preset.filename);
  if (existsSync(destination)) {
    return { preset, installed: { path: destination, filename: preset.filename, skipped: true } };
  }
  update?.({ progress: 0.08, progressLabel: `开始下载 ${preset.name}` });
  await downloadFile(preset.url, destination, {
    signal,
    onProgress: (progress) => update?.({
      progress: Math.max(0.08, Math.min(0.95, progress)),
      progressLabel: `下载 ${preset.displayName} ${Math.round(progress * 100)}%`,
    }),
  });
  const info = await stat(destination);
  return {
    preset,
    installed: { path: destination, filename: preset.filename, size: info.size, skipped: false },
  };
}

export async function importControlNetResource(input = {}) {
  const sourcePath = resolve(String(input.path || ""));
  const info = await stat(sourcePath).catch(() => null);
  if (!info?.isFile()) throw badRequest("ControlNet 文件不存在或不可读取。");
  const extension = extname(sourcePath).toLowerCase();
  if (![".safetensors", ".pth", ".pt"].includes(extension)) {
    throw badRequest(`ControlNet 不支持 ${extension || "无扩展名"} 文件。`);
  }
  const targetDir = await resolveControlNetDir();
  await mkdir(targetDir, { recursive: true });
  const filename = sanitizeFilename(input.name || basename(sourcePath));
  const destination = await uniqueDestinationPath(targetDir, filename, Boolean(input.overwrite));
  if (sourcePath !== destination) await copyFile(sourcePath, destination);
  return {
    imported: {
      filename: basename(destination),
      path: destination,
      size: info.size,
      skipped: sourcePath === destination,
    },
  };
}

export function profilesFromControlNetPresets(resources = []) {
  return controlNetPresets
    .filter((preset) => resources.some((resource) => [resource.name, resource.title, resource.path].some((value) => String(value || "").includes(preset.filename.replace(/\.[^.]+$/, "")))))
    .map((preset) => ({
      type: "controlnet",
      name: preset.filename,
      title: preset.displayName,
      path: preset.filename,
      source: "preset",
      baseType: preset.baseType,
      controlType: preset.controlType,
      defaultPreprocessor: preset.defaultPreprocessor,
      defaultModule: preset.defaultModule,
      defaultControlWeight: preset.defaultControlWeight,
      notes: preset.purpose,
    }));
}

async function downloadFile(url, destination, { signal, onProgress } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载失败：${response.status} ${await response.text()}`);
  const total = Number(response.headers.get("content-length") || 0);
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    received += buffer.length;
    if (total > 0) onProgress?.(received / total);
  }
  await writeFile(destination, Buffer.concat(chunks));
}

async function resolveControlNetDir() {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines?.a1111 || {};
  const engineRoot = process.env.SD_WEBUI_ROOT
    ? resolve(process.env.SD_WEBUI_ROOT)
    : resolve(projectRoot, manifest.installDir || "vendor/engines", engine.directory || "stable-diffusion-webui");
  return join(engineRoot, engine.modelDirs?.controlnet || "models/ControlNet");
}

async function resolveControlNetExtensionDir() {
  const manifest = await loadEngineManifest();
  const engine = manifest.engines?.a1111 || {};
  const engineRoot = process.env.SD_WEBUI_ROOT
    ? resolve(process.env.SD_WEBUI_ROOT)
    : resolve(projectRoot, manifest.installDir || "vendor/engines", engine.directory || "stable-diffusion-webui");
  return join(engineRoot, "extensions", controlNetExtensionDir);
}

async function uniqueDestinationPath(targetDir, filename, overwrite = false) {
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
