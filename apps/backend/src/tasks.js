import { randomUUID } from "node:crypto";
import {
  getGenerationProgress,
  interruptGeneration,
  runGeneration,
  getBackendName,
  unloadA1111Model,
} from "./engines.js";
import {
  getActiveProviderProfile,
  getAppSettings,
  getTask,
  insertGeneration,
  insertTask,
  listTasks,
  listTasksByStatus,
  updateTask,
} from "./db.js";
import { stopLocalLlmModel } from "./local-llm.js";
import { trainLoraProject } from "./lora-training.js";
import { installControlNetExtension, installControlNetPreset } from "./controlnet-resources.js";

const runningTasks = new Map();
const queuedTaskIds = [];
let activeTaskId = "";

export function restoreInterruptedTasks() {
  for (const task of listTasksByStatus(["queued", "running", "cancelling"])) {
    updateTask(task.id, {
      status: "failed",
      progress: task.progress || 0,
      progressLabel: "服务重启，任务未完成",
      error: "Backend restarted before the task completed.",
      completedAt: new Date().toISOString(),
    });
  }
}

export function createGenerationTask({ plan, parentTaskId = "" }) {
  const task = insertTask({
    id: randomUUID(),
    backend: getBackendName(),
    status: "queued",
    plan,
    parentTaskId,
  });
  queuedTaskIds.push(task.id);
  scheduleQueue();
  return task;
}

export function createLoraTrainingTask({ projectId, parentTaskId = "" }) {
  const task = insertTask({
    id: randomUUID(),
    backend: "kohya_ss",
    status: "queued",
    plan: { task_type: "lora_training", projectId },
    parentTaskId,
  });
  queuedTaskIds.push(task.id);
  scheduleQueue();
  return task;
}

export function createControlNetInstallTask({ presetId, parentTaskId = "" }) {
  const taskType = presetId === "extension" ? "controlnet_extension_install" : "controlnet_install";
  const task = insertTask({
    id: randomUUID(),
    backend: taskType,
    status: "queued",
    plan: { task_type: taskType, presetId },
    parentTaskId,
  });
  queuedTaskIds.push(task.id);
  scheduleQueue();
  return task;
}

export function retryGenerationTask(taskId, { preparePlan = (plan) => plan } = {}) {
  const source = getTask(taskId);
  if (!source) return null;
  if (source.plan?.task_type === "lora_training") {
    return createLoraTrainingTask({ projectId: source.plan.projectId, parentTaskId: source.id });
  }
  if (source.plan?.task_type === "controlnet_install" || source.plan?.task_type === "controlnet_extension_install") {
    return createControlNetInstallTask({ presetId: source.plan.presetId, parentTaskId: source.id });
  }
  return createGenerationTask({
    plan: preparePlan(source.plan),
    parentTaskId: source.id,
  });
}

export async function cancelGenerationTask(taskId) {
  const task = getTask(taskId);
  if (!task) return null;

  if (task.status === "queued") {
    const index = queuedTaskIds.indexOf(taskId);
    if (index >= 0) queuedTaskIds.splice(index, 1);
    return updateTask(taskId, {
      status: "cancelled",
      progress: task.progress,
      progressLabel: "已取消",
      completedAt: new Date().toISOString(),
    });
  }

  if (task.status === "running") {
    updateTask(taskId, { status: "cancelling", progressLabel: "正在取消" });
    runningTasks.get(taskId)?.abortController?.abort();
    if (activeTaskId === taskId && !["lora_training", "controlnet_install", "controlnet_extension_install"].includes(task.plan?.task_type)) {
      await interruptGeneration();
    }
    return getTask(taskId);
  }

  return task;
}

export function getGenerationTask(taskId) {
  return getTask(taskId);
}

export function listGenerationTasks(options = {}) {
  return listTasks(options);
}

function scheduleQueue() {
  if (activeTaskId) return;
  const nextId = queuedTaskIds.shift();
  if (!nextId) return;

  const task = getTask(nextId);
  if (!task || task.status !== "queued") {
    scheduleQueue();
    return;
  }

  activeTaskId = nextId;
  void runTask(task).finally(() => {
    activeTaskId = "";
    scheduleQueue();
  });
}

async function runTask(task) {
  const abortController = new AbortController();
  runningTasks.set(task.id, { abortController });

  if (task.plan?.task_type === "lora_training") {
    await runLoraTrainingTask(task, abortController);
    runningTasks.delete(task.id);
    return;
  }

  if (task.plan?.task_type === "controlnet_install" || task.plan?.task_type === "controlnet_extension_install") {
    await runControlNetInstallTask(task, abortController);
    runningTasks.delete(task.id);
    return;
  }

  updateTask(task.id, {
    status: "running",
    progress: 0.02,
    progressLabel: "已提交到 A1111",
    startedAt: new Date().toISOString(),
  });

  const progressTimer = setInterval(() => {
    void updateProgress(task.id);
  }, 1000);

  const runtimeSettings = getAppSettings();
  const lowPerformanceEvents = [];

  try {
    if (runtimeSettings.lowPerformanceMode) {
      updateTask(task.id, {
        progress: 0.03,
        progressLabel: "Low performance mode: unloading local LLM",
      });
      const activeProvider = getActiveProviderProfile();
      if (activeProvider?.type === "local") {
        lowPerformanceEvents.push(await stopLocalLlmModel(activeProvider.model));
      }
    }

    const result = await runGeneration(task.plan, {
      onProgress: (patch = {}) => {
        updateTask(task.id, {
          progress: typeof patch.progress === "number" ? patch.progress : getTask(task.id)?.progress || 0.05,
          progressLabel: patch.progressLabel || getTask(task.id)?.progressLabel || "A1111 正在生成",
          result: sanitizeGenerationResult({
            ...(getTask(task.id)?.result || {}),
            pipelineStages: patch.pipelineStages,
          }),
        });
      },
    });

    if (runtimeSettings.lowPerformanceMode) {
      updateTask(task.id, {
        progress: 0.98,
        progressLabel: "Low performance mode: unloading image model",
      });
      lowPerformanceEvents.push(await unloadImageModelSafe());
    }

    clearInterval(progressTimer);

    const latest = getTask(task.id);
    if (latest?.status === "cancelling") {
      updateTask(task.id, {
        status: "cancelled",
        progress: latest.progress,
        progressLabel: "已取消",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const images = result.outputImages || [];
    if (images.length) {
      const resolvedPlan = applyResolvedSeed(task.plan, result);
      insertGeneration({
        id: randomUUID(),
        taskId: task.id,
        backend: task.backend,
        plan: resolvedPlan,
        images,
      });
    }

    updateTask(task.id, {
      status: "succeeded",
      progress: 1,
      progressLabel: `生成完成：${images.length} 张`,
      result: sanitizeGenerationResult({ ...result, lowPerformanceEvents }),
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    clearInterval(progressTimer);
    const latest = getTask(task.id);
    const cancelled = latest?.status === "cancelling" || abortController.signal.aborted;
    updateTask(task.id, {
      status: cancelled ? "cancelled" : "failed",
      progress: latest?.progress || 0,
      progressLabel: cancelled ? "已取消" : "生成失败",
      error: cancelled ? "" : error.message,
      completedAt: new Date().toISOString(),
    });
  } finally {
    runningTasks.delete(task.id);
  }
}

async function runLoraTrainingTask(task, abortController) {
  updateTask(task.id, {
    status: "running",
    progress: 0.02,
    progressLabel: "准备 LoRA 训练",
    startedAt: new Date().toISOString(),
  });
  try {
    const result = await trainLoraProject(task.plan.projectId, {
      signal: abortController.signal,
      update: (patch) => updateTask(task.id, patch),
    });
    const latest = getTask(task.id);
    if (latest?.status === "cancelling") {
      updateTask(task.id, {
        status: "cancelled",
        progress: latest.progress,
        progressLabel: "已取消",
        completedAt: new Date().toISOString(),
      });
      return;
    }
    updateTask(task.id, {
      status: "succeeded",
      progress: 1,
      progressLabel: "LoRA 训练完成",
      result,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const latest = getTask(task.id);
    const cancelled = latest?.status === "cancelling" || abortController.signal.aborted;
    updateTask(task.id, {
      status: cancelled ? "cancelled" : "failed",
      progress: latest?.progress || 0,
      progressLabel: cancelled ? "已取消" : "LoRA 训练失败",
      error: cancelled ? "" : error.message,
      completedAt: new Date().toISOString(),
    });
  }
}

async function runControlNetInstallTask(task, abortController) {
  const installingExtension = task.plan?.task_type === "controlnet_extension_install";
  updateTask(task.id, {
    status: "running",
    progress: 0.05,
    progressLabel: installingExtension ? "准备安装 ControlNet 扩展" : "准备安装 ControlNet",
    startedAt: new Date().toISOString(),
  });
  try {
    const result = installingExtension
      ? await installControlNetExtension({
        signal: abortController.signal,
        update: (patch) => updateTask(task.id, patch),
      })
      : await installControlNetPreset(task.plan.presetId, {
        signal: abortController.signal,
        update: (patch) => updateTask(task.id, patch),
      });
    updateTask(task.id, {
      status: "succeeded",
      progress: 1,
      progressLabel: installingExtension ? "ControlNet 扩展安装完成，请重启 A1111" : "ControlNet 安装完成",
      result,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const latest = getTask(task.id);
    const cancelled = latest?.status === "cancelling" || abortController.signal.aborted;
    updateTask(task.id, {
      status: cancelled ? "cancelled" : "failed",
      progress: latest?.progress || 0,
      progressLabel: cancelled ? "已取消" : "ControlNet 安装失败",
      error: cancelled ? "" : error.message,
      completedAt: new Date().toISOString(),
    });
  }
}

function sanitizeGenerationResult(result = {}) {
  return {
    backend: result.backend,
    baseUrl: result.baseUrl,
    outputImages: result.outputImages || [],
    intermediateImages: result.intermediateImages || [],
    pipelineStages: result.pipelineStages || [],
    warnings: result.warnings || [],
    project: result.project,
    trainedModel: result.trainedModel,
    installed: result.installed,
    logs: result.logs,
    prompt_id: result.prompt_id,
    lowPerformanceEvents: result.lowPerformanceEvents || [],
  };
}

async function unloadImageModelSafe() {
  try {
    return await unloadA1111Model();
  } catch (error) {
    return {
      backend: getBackendName(),
      unloaded: false,
      error: error.message,
    };
  }
}

function applyResolvedSeed(plan, result = {}) {
  const seed = readSeedFromResult(result);
  return seed >= 0 ? { ...plan, seed } : plan;
}

function readSeedFromResult(result = {}) {
  const parameterSeed = Number(result.parameters?.seed);
  if (Number.isFinite(parameterSeed) && parameterSeed >= 0) return parameterSeed;

  try {
    const info = typeof result.info === "string" ? JSON.parse(result.info) : result.info;
    const infoSeed = Number(info?.seed ?? info?.all_seeds?.[0]);
    if (Number.isFinite(infoSeed) && infoSeed >= 0) return infoSeed;
  } catch {
    return -1;
  }

  return -1;
}

async function updateProgress(taskId) {
  const task = getTask(taskId);
  if (!task || task.status !== "running") return;

  try {
    const progress = await getGenerationProgress();
    const state = progress.state || {};
    const samplingStep = Number(state.sampling_step || state.samplingStep || 0);
    const samplingSteps = Number(state.sampling_steps || state.samplingSteps || task.plan.steps || 0);
    const label = samplingSteps > 0
      ? `采样中 ${samplingStep}/${samplingSteps}`
      : progress.etaRelative
        ? `预计剩余 ${Math.ceil(progress.etaRelative)} 秒`
        : "A1111 正在生成";

    updateTask(taskId, {
      progress: Math.max(0.02, Math.min(0.98, progress.progress || 0)),
      progressLabel: label,
      result: {
        progressPreview: progress.currentImage,
        progressState: state,
        etaRelative: progress.etaRelative,
      },
    });
  } catch {
    updateTask(taskId, {
      progressLabel: "等待 A1111 进度",
    });
  }
}
