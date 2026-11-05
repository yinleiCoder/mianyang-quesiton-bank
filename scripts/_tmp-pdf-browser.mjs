// 临时脚本：把扫描版 PDF 逐页渲染成 PNG（pdf.js + Chrome headless）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "docs", "_pdf_pages");
const docsDir = path.join(root, "docs");
const pdfName = fs.readdirSync(docsDir).find((n) => n.toLowerCase().endsWith(".pdf"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/doc.pdf") {
    const pdfPath = path.join(docsDir, pdfName);
    const size = fs.statSync(pdfPath).size;
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": size, "Accept-Ranges": "bytes" });
    if (req.method === "HEAD") { res.end(); return; }
    fs.createReadStream(pdfPath).pipe(res);
    return;
  }
  const file = path.join(root, url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  const size = fs.statSync(file).size;
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Content-Length": size,
  });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(file).pipe(res);
});

const PORT = 8765;
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = path.join(outDir, "chrome-profile");
fs.mkdirSync(profile, { recursive: true });
const CDP = 9333;
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP}`,
  "--window-size=1240,1754",
  "about:blank",
], { stdio: "ignore" });

async function waitForCdp() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Chrome CDP 未就绪");
}
await waitForCdp();

const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
const target = list.find((t) => t.type === "page");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send("Page.enable");
await send("Runtime.enable");

for (let page = 1; page <= 13; page++) {
  const url = `http://127.0.0.1:${PORT}/docs/_pdf_pages/render.html?page=${page}`;
  await send("Page.navigate", { url });
  let ok = false;
  for (let t = 0; t < 200; t++) {
    await new Promise((r) => setTimeout(r, 250));
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify({d: window.__pdfDone, e: window.__pdfError, s: window.__pdfSize})",
      returnByValue: true,
    });
    const v = r.result?.value;
    if (v && v !== "undefined") {
      const o = JSON.parse(v);
      if (o.e) { console.log(`page ${page} ERROR`, o.e); break; }
      if (o.d) { ok = true; break; }
    }
  }
  if (!ok) { console.log(`page ${page}: 渲染超时`); continue; }
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1240, height: 1754, scale: 1 },
  });
  const out = path.join(outDir, `render${String(page).padStart(2, "0")}.png`);
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("ok", out, fs.statSync(out).size);
}

ws.close();
chrome.kill();
server.close();
process.exit(0);
