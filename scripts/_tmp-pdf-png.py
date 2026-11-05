import json, os, sys
from PIL import Image

base = r"D:\FullStackProjects\mianyang-question-bank\docs\_pdf_pages"
man = json.load(open(os.path.join(base, "manifest.json"), encoding="utf-8"))
for m in man:
    raw = open(os.path.join(base, os.path.basename(m["raw"])), "rb").read()
    w, h = m["width"], m["height"]
    img = Image.frombytes("RGB", (w, h), raw)
    out = os.path.join(base, f"page{m['page']:02d}.png")
    img.save(out, optimize=True)
    print(out, os.path.getsize(out))
