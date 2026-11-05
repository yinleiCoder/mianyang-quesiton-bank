import fs from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const file = process.argv[2];
const outDir = process.argv[3] || "docs/_pdf_render";
const scale = Number(process.argv[4] || 2);
fs.mkdirSync(outDir, { recursive: true });

const wasmDir = path.resolve("node_modules/pdfjs-dist/wasm").replace(/\\/g, "/") + "/";
const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, wasmUrl: wasmDir, useSystemFonts: true }).promise;
console.log("pages:", doc.numPages);

const canvasFactory = {
  create(width, height) {
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return { canvas, context: canvas.getContext("2d") };
  },
  reset(cc, width, height) {
    cc.canvas.width = Math.ceil(width);
    cc.canvas.height = Math.ceil(height);
  },
  destroy(cc) {
    cc.canvas.width = 0;
    cc.canvas.height = 0;
  },
};

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale });
  const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);
  await page.render({ canvasContext: context, viewport, canvasFactory }).promise;
  const out = path.join(outDir, `p${String(i).padStart(2, "0")}.png`);
  fs.writeFileSync(out, canvas.toBuffer("image/png"));
  console.log("wrote", out, canvas.width, canvas.height);
}
