import sys
import json
from PIL import Image
import numpy as np
from rapidocr_onnxruntime import RapidOCR

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

def main():
    png = sys.argv[1]
    x = int(sys.argv[2]); y = int(sys.argv[3])
    w = int(sys.argv[4]); h = int(sys.argv[5])
    scale = float(sys.argv[6])

    im = Image.open(png).convert("RGB")
    x = max(0, x); y = max(0, y)
    w = min(w, im.width - x); h = min(h, im.height - y)
    im = im.crop((x, y, x + w, y + h))
    if scale != 1:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)

    engine = RapidOCR()
    result, _ = engine(np.array(im))

    lines = []
    for box, text, score in (result or []):
        xs = [pt[0] for pt in box]; ys = [pt[1] for pt in box]
        lines.append({
            "text": text,
            "x": int(x + min(xs) / scale),
            "y": int(y + min(ys) / scale),
            "w": int((max(xs) - min(xs)) / scale),
            "h": int((max(ys) - min(ys)) / scale),
            "score": round(float(score), 4),
        })
    print(json.dumps({"ok": True, "lines": lines}, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "lines": []}, ensure_ascii=False))
