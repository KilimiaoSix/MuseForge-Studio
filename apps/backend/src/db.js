import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dataDir = join(projectRoot, "data");
const outputRoot = join(projectRoot, "outputs", "generations");
const providerSecretPath = join(dataDir, "provider-secret.key");

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
    favorite INTEGER NOT NULL DEFAULT 0,
    purpose TEXT NOT NULL DEFAULT '',
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

  CREATE TABLE IF NOT EXISTS resource_profiles (
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    base_type TEXT NOT NULL DEFAULT 'unknown',
    preferred_vae TEXT NOT NULL DEFAULT '',
    recommended_size_json TEXT NOT NULL DEFAULT '{}',
    trigger_words_json TEXT NOT NULL DEFAULT '[]',
    default_weight REAL NOT NULL DEFAULT 0,
    compatible_checkpoints_json TEXT NOT NULL DEFAULT '[]',
    blocked_checkpoints_json TEXT NOT NULL DEFAULT '[]',
    control_type TEXT NOT NULL DEFAULT '',
    default_preprocessor TEXT NOT NULL DEFAULT '',
    default_module TEXT NOT NULL DEFAULT '',
    default_control_weight REAL NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    user_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (type, name)
  );

  CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    api_key_secret TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 0,
    test_status TEXT NOT NULL DEFAULT '',
    test_message TEXT NOT NULL DEFAULT '',
    tested_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

ensureColumn("generations", "favorite", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("generations", "purpose", "TEXT NOT NULL DEFAULT ''");

const defaultAppSettings = Object.freeze({
  lowPerformanceMode: false,
});

export function getAppSettings() {
  const rows = db.prepare("SELECT key, value FROM app_settings").all();
  const settings = { ...defaultAppSettings };

  for (const row of rows) {
    if (!Object.hasOwn(defaultAppSettings, row.key)) continue;
    settings[row.key] = parseSettingValue(row.value, defaultAppSettings[row.key]);
  }

  return settings;
}

export function updateAppSettings(patch = {}) {
  const now = new Date().toISOString();
  for (const key of Object.keys(defaultAppSettings)) {
    if (!Object.hasOwn(patch, key)) continue;
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(Boolean(patch[key])), now);
  }

  return getAppSettings();
}

export function listProviderProfiles() {
  return db.prepare(`
    SELECT * FROM provider_profiles
    ORDER BY is_active DESC, updated_at DESC, created_at DESC
  `).all().map(mapProviderProfile);
}

export function getProviderProfile(id) {
  const row = db.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id);
  return row ? mapProviderProfile(row) : null;
}

export function getActiveProviderProfile() {
  const row = db.prepare(`
    SELECT * FROM provider_profiles
    WHERE is_active = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  return row ? mapProviderProfile(row) : null;
}

export function insertProviderProfile({ id, name, type, baseUrl = "", model = "", apiKey = "", isActive = false }) {
  const now = new Date().toISOString();
  const hasActive = Boolean(getActiveProviderProfile());
  const shouldActivate = Boolean(isActive || !hasActive);

  if (shouldActivate) deactivateProviderProfiles();

  db.prepare(`
    INSERT INTO provider_profiles
      (id, name, type, base_url, model, api_key_secret, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    type,
    baseUrl || "",
    model || "",
    apiKey ? encryptSecret(apiKey) : "",
    shouldActivate ? 1 : 0,
    now,
    now,
  );

  return getProviderProfile(id);
}

export function updateProviderProfile(id, patch = {}) {
  const current = getProviderProfile(id);
  if (!current) return null;

  const assignments = [];
  const values = [];
  const columnMap = {
    name: "name",
    type: "type",
    baseUrl: "base_url",
    model: "model",
  };

  for (const [key, column] of Object.entries(columnMap)) {
    if (Object.hasOwn(patch, key)) {
      assignments.push(`${column} = ?`);
      values.push(patch[key] || "");
    }
  }

  if (Object.hasOwn(patch, "apiKey")) {
    assignments.push("api_key_secret = ?");
    values.push(patch.apiKey ? encryptSecret(patch.apiKey) : "");
  }

  if (Object.hasOwn(patch, "isActive")) {
    if (patch.isActive) deactivateProviderProfiles();
    assignments.push("is_active = ?");
    values.push(patch.isActive ? 1 : 0);
  }

  if (!assignments.length) return current;

  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE provider_profiles SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return getProviderProfile(id);
}

export function activateProviderProfile(id) {
  if (!getProviderProfile(id)) return null;
  deactivateProviderProfiles();
  db.prepare("UPDATE provider_profiles SET is_active = 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  return getProviderProfile(id);
}

export function deleteProviderProfile(id) {
  const profile = getProviderProfile(id);
  if (!profile) return null;

  db.prepare("DELETE FROM provider_profiles WHERE id = ?").run(id);

  if (profile.isActive) {
    const next = db.prepare(`
      SELECT id FROM provider_profiles
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get();
    if (next?.id) activateProviderProfile(next.id);
  }

  return profile;
}

export function updateProviderTestStatus(id, { status = "", message = "" } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE provider_profiles
    SET test_status = ?, test_message = ?, tested_at = ?, updated_at = ?
    WHERE id = ?
  `).run(status || "", message || "", now, now, id);
  return getProviderProfile(id);
}

export function profileToProviderConfig(profile) {
  if (!profile) return null;
  return {
    type: profile.type,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: decryptSecret(profile.apiKeySecret),
  };
}

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

export function updateGeneration(id, patch = {}) {
  const current = getGeneration(id);
  if (!current) return null;
  const assignments = [];
  const values = [];
  if (Object.hasOwn(patch, "favorite")) {
    assignments.push("favorite = ?");
    values.push(patch.favorite ? 1 : 0);
  }
  if (Object.hasOwn(patch, "purpose")) {
    assignments.push("purpose = ?");
    values.push(String(patch.purpose || "").trim());
  }
  if (!assignments.length) return current;
  values.push(id);
  db.prepare(`UPDATE generations SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return getGeneration(id);
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

export function deleteGenerations(ids = [], { deleteFiles = true } = {}) {
  const deleted = [];
  for (const id of ids.map((value) => String(value || "").trim()).filter(Boolean)) {
    const generation = deleteGeneration(id, { deleteFiles });
    if (generation) deleted.push(generation);
  }
  return deleted;
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

export function upsertResourceProfiles(profiles = []) {
  const statement = db.prepare(`
    INSERT INTO resource_profiles (
      type, name, title, path, source, base_type, preferred_vae, recommended_size_json,
      trigger_words_json, default_weight, compatible_checkpoints_json, blocked_checkpoints_json,
      control_type, default_preprocessor, default_module, default_control_weight,
      notes, user_confirmed, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(type, name) DO UPDATE SET
      title = excluded.title,
      path = excluded.path,
      source = excluded.source,
      base_type = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.base_type ELSE excluded.base_type END,
      preferred_vae = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.preferred_vae ELSE excluded.preferred_vae END,
      recommended_size_json = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.recommended_size_json ELSE excluded.recommended_size_json END,
      trigger_words_json = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.trigger_words_json ELSE excluded.trigger_words_json END,
      default_weight = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.default_weight ELSE excluded.default_weight END,
      control_type = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.control_type ELSE excluded.control_type END,
      default_preprocessor = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.default_preprocessor ELSE excluded.default_preprocessor END,
      default_module = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.default_module ELSE excluded.default_module END,
      default_control_weight = CASE WHEN resource_profiles.user_confirmed = 1 THEN resource_profiles.default_control_weight ELSE excluded.default_control_weight END,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  for (const profile of profiles) {
    statement.run(
      normalizeResourceType(profile.type),
      String(profile.name || "").trim(),
      profile.title || "",
      profile.path || "",
      profile.source || "",
      normalizeBaseType(profile.baseType),
      profile.preferredVae || "",
      JSON.stringify(profile.recommendedSize || {}),
      JSON.stringify(Array.isArray(profile.triggerWords) ? profile.triggerWords : []),
      Number(profile.defaultWeight || 0),
      JSON.stringify(Array.isArray(profile.compatibleCheckpoints) ? profile.compatibleCheckpoints : []),
      JSON.stringify(Array.isArray(profile.blockedCheckpoints) ? profile.blockedCheckpoints : []),
      profile.controlType || "",
      profile.defaultPreprocessor || "",
      profile.defaultModule || "",
      Number(profile.defaultControlWeight || 0),
      profile.notes || "",
      now,
      now,
    );
  }
}

export function listResourceProfiles() {
  return db.prepare(`
    SELECT * FROM resource_profiles
    ORDER BY type ASC, base_type ASC, name ASC
  `).all().map(mapResourceProfile);
}

export function getResourceProfile(type, name) {
  const row = db.prepare("SELECT * FROM resource_profiles WHERE type = ? AND name = ?").get(normalizeResourceType(type), name);
  return row ? mapResourceProfile(row) : null;
}

export function updateResourceProfile(type, name, patch = {}) {
  const current = getResourceProfile(type, name);
  if (!current) return null;

  const assignments = [];
  const values = [];
  const stringColumns = {
    title: "title",
    path: "path",
    source: "source",
    preferredVae: "preferred_vae",
    controlType: "control_type",
    defaultPreprocessor: "default_preprocessor",
    defaultModule: "default_module",
    notes: "notes",
  };

  if (Object.hasOwn(patch, "baseType")) {
    assignments.push("base_type = ?");
    values.push(normalizeBaseType(patch.baseType));
  }

  for (const [key, column] of Object.entries(stringColumns)) {
    if (Object.hasOwn(patch, key)) {
      assignments.push(`${column} = ?`);
      values.push(String(patch[key] || ""));
    }
  }

  const jsonColumns = {
    recommendedSize: "recommended_size_json",
    triggerWords: "trigger_words_json",
    compatibleCheckpoints: "compatible_checkpoints_json",
    blockedCheckpoints: "blocked_checkpoints_json",
  };

  for (const [key, column] of Object.entries(jsonColumns)) {
    if (Object.hasOwn(patch, key)) {
      assignments.push(`${column} = ?`);
      values.push(JSON.stringify(patch[key] || (key === "recommendedSize" ? {} : [])));
    }
  }

  if (Object.hasOwn(patch, "defaultWeight")) {
    assignments.push("default_weight = ?");
    values.push(Number(patch.defaultWeight || 0));
  }

  if (Object.hasOwn(patch, "defaultControlWeight")) {
    assignments.push("default_control_weight = ?");
    values.push(Number(patch.defaultControlWeight || 0));
  }

  if (Object.hasOwn(patch, "userConfirmed")) {
    assignments.push("user_confirmed = ?");
    values.push(patch.userConfirmed ? 1 : 0);
  } else {
    assignments.push("user_confirmed = 1");
  }

  if (!assignments.length) return current;
  assignments.push("updated_at = ?");
  values.push(new Date().toISOString(), normalizeResourceType(type), name);
  db.prepare(`UPDATE resource_profiles SET ${assignments.join(", ")} WHERE type = ? AND name = ?`).run(...values);
  return getResourceProfile(type, name);
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

function mapProviderProfile(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    model: row.model,
    apiKeySecret: row.api_key_secret || "",
    hasApiKey: Boolean(row.api_key_secret),
    keyPreview: previewEncryptedSecret(row.api_key_secret),
    isActive: Boolean(row.is_active),
    testStatus: row.test_status || "",
    testMessage: row.test_message || "",
    testedAt: row.tested_at || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapResourceProfile(row) {
  return {
    type: row.type,
    name: row.name,
    title: row.title,
    path: row.path,
    source: row.source,
    baseType: row.base_type || "unknown",
    preferredVae: row.preferred_vae || "",
    recommendedSize: parseJson(row.recommended_size_json, {}),
    triggerWords: parseJson(row.trigger_words_json, []),
    defaultWeight: Number(row.default_weight || 0),
    compatibleCheckpoints: parseJson(row.compatible_checkpoints_json, []),
    blockedCheckpoints: parseJson(row.blocked_checkpoints_json, []),
    controlType: row.control_type || "",
    defaultPreprocessor: row.default_preprocessor || "",
    defaultModule: row.default_module || "",
    defaultControlWeight: Number(row.default_control_weight || 0),
    notes: row.notes || "",
    userConfirmed: Boolean(row.user_confirmed),
    createdAt: row.created_at,
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
    favorite: Boolean(row.favorite),
    purpose: row.purpose || "",
    createdAt: row.created_at,
  };
}

function ensureColumn(table, column, definition) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function deactivateProviderProfiles() {
  db.prepare("UPDATE provider_profiles SET is_active = 0, updated_at = ?").run(new Date().toISOString());
}

function getProviderSecretKey() {
  if (existsSync(providerSecretPath)) {
    const stored = Buffer.from(readFileSync(providerSecretPath, "utf8").trim(), "base64");
    if (stored.length === 32) return stored;
  }

  const key = randomBytes(32);
  writeFileSync(providerSecretPath, key.toString("base64"), { mode: 0o600 });
  return key;
}

function encryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getProviderSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptSecret(value) {
  if (!value) return "";

  try {
    const [version, ivBase64, tagBase64, encryptedBase64] = String(value).split(":");
    if (version !== "v1") return "";
    const decipher = createDecipheriv("aes-256-gcm", getProviderSecretKey(), Buffer.from(ivBase64, "base64"));
    decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedBase64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function previewEncryptedSecret(value) {
  const secret = decryptSecret(value);
  if (!secret) return "";
  if (secret.length <= 10) return "***";
  return `${secret.slice(0, 3)}...${secret.slice(-4)}`;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseSettingValue(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeResourceType(type) {
  const value = String(type || "").trim().toLowerCase();
  return ["checkpoint", "lora", "vae", "controlnet", "sampler"].includes(value) ? value : "checkpoint";
}

function normalizeBaseType(value) {
  const type = String(value || "unknown").trim().toLowerCase();
  return ["sd15", "sdxl", "pony", "flux", "universal", "unknown"].includes(type) ? type : "unknown";
}

function sanitizeTaskResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    backend: result.backend,
    baseUrl: result.baseUrl,
    outputImages: result.outputImages || [],
    intermediateImages: result.intermediateImages || [],
    pipelineStages: result.pipelineStages || [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    project: result.project || null,
    trainedModel: result.trainedModel || null,
    installed: result.installed || null,
    preset: result.preset || null,
    logs: Array.isArray(result.logs) ? result.logs : [],
    command: result.command || "",
    progressPreview: result.progressPreview || "",
    progressState: result.progressState || {},
    etaRelative: result.etaRelative ?? null,
    prompt_id: result.prompt_id,
  };
}
