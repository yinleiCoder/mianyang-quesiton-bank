import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const wasmDir = path.join(root, "node_modules", "pdfjs-dist", "wasm").replace(/\\/g, "/") + "/";
const dir = path.join(root, "docs");
const name = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".pdf"));
const data = new Uint8Array(fs.readFileSync(path.join(dir, name)));
const doc = await getDocument({ data, wasmUrl: wasmDir, useSystemFonts: true }).promise;

const reverse = {};
for (const [k, v] of Object.entries(OPS)) reverse[v] = k;

for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const counts = {};
  for (const fn of ops.fnArray) {
    const key = reverse[fn] || String(fn);
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log(`page ${i} viewport=${vp.width}x${vp.height}`, JSON.stringify(counts));
  // dump interesting args
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintFormXObjectBegin || fn === OPS.paintInlineImageXObject || fn === OPS.setFillColorN || fn === OPS.constructPath) {
      const a = ops.argsArray[k];
      console.log("   ", reverse[fn], JSON.stringify(a).slice(0, 160));
    }
  }
}
