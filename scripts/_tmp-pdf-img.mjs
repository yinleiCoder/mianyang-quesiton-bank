import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const wasmDir = path.join(root, "node_modules", "pdfjs-dist", "wasm").replace(/\\/g, "/") + "/";

const dir = path.join(root, "docs");
const name = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".pdf"));
const file = path.join(dir, name);
const outDir = path.join(root, "docs", "_pdf_pages");
fs.mkdirSync(outDir, { recursive: true });

const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, wasmUrl: wasmDir, useSystemFonts: true }).promise;

async function waitObj(page, id) {
  for (let t = 0; t < 300; t++) {
    try {
      return page.objs.get(id);
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return null;
}

const manifest = [];
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const ops = await page.getOperatorList();
  const ids = [];
  for (let k = 0; k < ops.fnArray.length; k++) {
    const fn = ops.fnArray[k];
    if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) ids.push(ops.argsArray[k][0]);
  }
  console.log(`page ${i}: ids=${JSON.stringify(ids)}`);
  for (const id of ids) {
    const obj = await waitObj(page, id);
    if (!obj) { console.log("  unresolved", id); continue; }
    const raw = obj.data;
    console.log("  ", id, "kind:", obj.kind, "w:", obj.width, "h:", obj.height, "bytes:", raw?.length, "keys:", Object.keys(obj).join(","));
    if (raw && obj.width && obj.height) {
      const base = path.join(outDir, `p${String(i).padStart(2, "0")}_${id}`);
      fs.writeFileSync(`${base}.raw`, Buffer.from(raw));
      fs.writeFileSync(`${base}.json`, JSON.stringify({ kind: obj.kind, width: obj.width, height: obj.height }));
      manifest.push({ page: i, id, kind: obj.kind, width: obj.width, height: obj.height, raw: `${base}.raw` });
    }
  }
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log("done");
