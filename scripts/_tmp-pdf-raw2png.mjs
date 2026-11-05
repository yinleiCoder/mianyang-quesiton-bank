import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const dir = path.resolve("docs/_pdf_pages");
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
for (const item of manifest) {
  const buf = fs.readFileSync(item.raw);
  const out = path.join(dir, `page${String(item.page).padStart(2, "0")}.png`);
  await sharp(buf, { raw: { width: item.width, height: item.height, channels: 3 } })
    .png()
    .toFile(out);
  console.log("wrote", out, item.width, item.height);
}
