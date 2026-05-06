import { existsSync, mkdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = join(projectRoot, "data");
const outputRoot = join(projectRoot, "outputs", "generations");

mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(join(dataDir, "museforge.sqlite"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS generation_tasks (
    id TEXT PRIMARY KEY,
    backend TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    progress_label TEXT NOT NULL DEFAULT '',
    plan_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    parent_task_id TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    task_id TEXT,
    backend TEXT NOT NULL,
    prompt TEXT NOT NULL,
    negative_prompt TEXT NOT NULL,
    checkpoint TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    images_json TEXT NOT NULL,
    seed INTEGER NOT NULL DEFAULT -1,
    width INTEGER NOT NULL DEFAULT 512,
    height INTEGER NOT NULL DEFAULT 512,
    rationale TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resource_index (
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (type, name)
  );
`);

export function insertTask({ id, backend, status = "queued", plan, parentTaskId = "" }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO generation_tasks
      (id, backend, status, progress, progress_label, plan_json, parent_task_id, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(id, backend, status, "等待执行", JSON.stringify(plan), parentTaskId || "", now, now);
  return getTask(id);
}

export function updateTask(id, patch = {}) {
  const allowed = new Map([
    ["status", "status"],
    ["progress", "progress"],
    ["progressLabel", "progress_label"],
    ["result", "result_json"],
    ["error", "error"],
    ["startedAt", "started_at"],
    ["completedAt", "completed_at"],
  ]);

  const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
  if (!entries.length) return getTask(id);

  const assignments = [];
  const values = [];
  for (const [key, value] of entries) {
    assignments.push(`${allowed.get(key)} = ?`);
    values.push(key === "result" ? JSON.stringify(value) : value);
  }

  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE generation_tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return getTask(id);
}

export function getTask(id) {
  const row = db.prepare("SELECT * FROM generation_tasks WHERE id = ?").get(id);
  return row ? mapTask(row) : null;
}

export function listTasks({ limit = 30, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM generation_tasks
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return rows.map(mapTask);
}

export function listTasksByStatus(statuses = []) {
  if (!statuses.length) return [];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT * FROM generation_tasks
    WHERE status IN (${placeholders})
    ORDER BY created_at ASC
  `).all(...statuses);
  return rows.map(mapTask);
}

export function insertGeneration({ id, taskId, backend, plan, images }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO generations
      (id, task_id, backend, prompt, negative_prompt, checkpoint, plan_json, images_json, seed, width, height, rationale, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId || "",
    backend,
    plan.positive_prompt || "",
    plan.negative_prompt || "",
    plan.checkpoint || "",
    JSON.stringify(plan),
    JSON.stringify(images || []),
    Number.isFinite(Number(plan.seed)) ? Number(plan.seed) : -1,
    Number(plan.width || 512),
    Number(plan.height || 512),
    plan.rationale || "",
    now,
  );
  return getGeneration(id);
}

export function listGenerations({ limit = 40, offset = 0 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM generations
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return rows.map(mapGeneration);
}

export function getGeneration(id) {
  const row = db.prepare("SELECT * FROM generations WHERE id = ?").get(id);
  return row ? mapGeneration(row) : null;
}

export function deleteGeneration(id, { deleteFiles = true } = {}) {
  const generation = getGeneration(id);
  if (!generation) return null;

  db.prepare("DELETE FROM generations WHERE id = ?").run(id);

  if (deleteFiles) {
    for (const image of generation.images) {
      const filename = String(image.filename || "").trim();
      if (!filename) continue;
      const file = resolve(outputRoot, filename);
      if (!file.startsWith(outputRoot) || !existsSync(file)) continue;
      rmSync(file, { force: true });
    }
  }

  return generation;
}

export function upsertResources(resources = []) {
  const statement = db.prepare(`
    INSERT INTO resource_index (type, name, title, source, path, purpose, updated_at)
    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT purpose FROM resource_index WHERE type = ? AND name = ?), ''), ?)
    ON CONFLICT(type, name) DO UPDATE SET
      title = excluded.title,
      source = excluded.source,
      path = excluded.path,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const resource of resources) {
    statement.run(
      resource.type,
      resource.name,
      resource.title || "",
      resource.source || "",
      resource.path || "",
      resource.type,
      resource.name,
      now,
    );
  }
}

export function updateResourcePurpose(type, name, purpose = "") {
  db.prepare(`
    UPDATE resource_index
    SET purpose = ?, updated_at = ?
    WHERE type = ? AND name = ?
  `).run(purpose, new Date().toISOString(), type, name);
}

export function listResourceIndex() {
  return db.prepare("SELECT * FROM resource_index ORDER BY type ASC, name ASC").all().map((row) => ({
    type: row.type,
    name: row.name,
    title: row.title,
    source: row.source,
    path: row.path,
    purpose: row.purpose,
    updatedAt: row.updated_at,
  }));
}

function mapTask(row) {
  return {
    id: row.id,
    backend: row.backend,
    status: row.status,
    progress: Number(row.progress || 0),
    progressLabel: row.progress_label || "",
    plan: parseJson(row.plan_json, {}),
    result: sanitizeTaskResult(parseJson(row.result_json, null)),
    error: row.error || "",
    parentTaskId: row.parent_task_id || "",
    createdAt: row.created_at,
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    updatedAt: row.updated_at,
  };
}

function mapGeneration(row) {
  return {
    id: row.id,
    taskId: row.task_id || "",
    backend: row.backend,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    checkpoint: row.checkpoint,
    plan: parseJson(row.plan_json, {}),
    images: parseJson(row.images_json, []),
    seed: Number(row.seed),
    width: Number(row.width),
    height: Number(row.height),
    rationale: row.rationale || "",
    createdAt: row.created_at,
  };
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sanitizeTaskResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    backend: result.backend,
    baseUrl: result.baseUrl,
    outputImages: result.outputImages || [],
    progressPreview: result.progressPreview || "",
    progressState: result.progressState || {},
    etaRelative: result.etaRelative ?? null,
    prompt_id: result.prompt_id,
    comfyImages: result.images && !result.outputImages ? result.images : undefined,
  };
}
