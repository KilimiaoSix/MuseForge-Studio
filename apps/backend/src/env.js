import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFile(filePath = findEnvFile()) {
  if (!existsSync(filePath)) return;

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = unquote(value);
  }
}

function findEnvFile() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..", ".env"),
  ];

  let current = process.cwd();
  while (dirname(current) !== current) {
    candidates.push(join(current, ".env"));
    current = dirname(current);
  }

  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
