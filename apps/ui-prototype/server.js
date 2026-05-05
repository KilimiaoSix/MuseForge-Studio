import { createServer } from "node:http";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(process.cwd(), "prototype");
const port = Number(process.env.UI_PROTOTYPE_PORT || 5177);

if (process.argv.includes("--check")) {
  console.log("ui prototype scaffold ok");
  process.exit(0);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(root, pathname);

  if (!file.startsWith(root) || !existsSync(file)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`UI prototype listening on http://127.0.0.1:${port}`);
});

