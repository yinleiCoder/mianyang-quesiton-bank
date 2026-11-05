import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "node:fs";

const file = process.argv[2];
const maxPages = Number(process.argv[3] || 99);
const data = new Uint8Array(fs.readFileSync(file));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
console.log("FILE:", file);
console.log("numPages:", doc.numPages);
const n = Math.min(doc.numPages, maxPages);
for (let i = 1; i <= n; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => it.str).join("");
  console.log(`\n--- page ${i} (chars=${text.length}) ---`);
  console.log(text);
}
