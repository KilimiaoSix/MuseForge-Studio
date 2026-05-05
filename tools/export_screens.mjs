import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const prototype = resolve(root, "apps", "ui-prototype", "prototype", "index.html");
const outDir = resolve(root, "screens");
mkdirSync(outDir, { recursive: true });

const screens = [
  ["overview", "01-overview-workbench.png"],
  ["generate", "02-natural-language-generate.png"],
  ["edit", "03-smart-edit.png"],
  ["lora", "04-lora-training.png"],
  ["models", "05-model-manager.png"],
  ["queue", "06-task-queue.png"],
  ["settings", "07-provider-settings.png"],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });

for (const [screen, name] of screens) {
  const url = `${pathToFileURL(prototype).href}?screen=${screen}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: resolve(outDir, name), fullPage: false });
  console.log(`exported ${name}`);
}

await browser.close();
