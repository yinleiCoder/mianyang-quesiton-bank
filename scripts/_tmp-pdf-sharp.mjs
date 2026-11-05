import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dir = path.join(root, "docs");
const name = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".pdf"));
const file = path.join(dir, name);
const outDir = path.join(dir, "_pdf_pages");
fs.mkdirSync(outDir, { recursive: true });

console.log("sharp:", sharp.versions);

for (let page = 1; page <= 13; page++) {
  try {
    const out = path.join(outDir, `render${String(page).padStart(2, "0")}.png`);
    await sharp(file, { density: 150, page, limitInputPixels: 1e9 })
      .flatten({ background: "#ffffff" })
      .png()
      .toFile(out);
    console.log("ok", out, fs.statSync(out).size);
  } catch (e) {
    console.log("fail page", page, e.message);
    break;
  }
}
