import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("docs");
const name = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith(".pdf"));
const file = path.join(dir, name);
console.log("file:", file);
const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
console.log("numPages:", doc.numPages);
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => it.str).join("");
  console.log(`--- page ${i} (chars=${text.length}) ---`);
  console.log(text.slice(0, 4000));
}
