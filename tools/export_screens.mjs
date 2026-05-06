import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
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

const server = spawn("npm", ["run", "dev:ui", "--", "--host", "127.0.0.1", "--port", "5177"], {
  cwd: root,
  stdio: "ignore",
});

await waitForUrl("http://127.0.0.1:5177");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });

for (const [screen, name] of screens) {
  const url = `http://127.0.0.1:5177/?screen=${screen}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.screenshot({ path: resolve(outDir, name), fullPage: false });
  console.log(`exported ${name}`);
}

await browser.close();
server.kill("SIGTERM");

async function waitForUrl(url) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep waiting for Vite
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
