"""比较前后两帧截图：中间到底有没有"新消息"。

为什么需要它：OCR 的文字不可靠 —— 同一张图/表情包，4B 每帧的描述措辞都不一样
（"蓝发Q版玩偶群像" / "蓝发女仆玩偶群像" / "蓝色头发玩偶群像，闭眼微笑"），
按文字做差分永远像"有新内容"。这里让模型直接看两张图来判：
**画面里到底有没有新出现的东西**，还是只是同一张图在刷新帧。

用法：python judge_frames.py <prev.png> <cur.png> [model] [url]
输出：{"ok": true, "new": true|false, "why": "..."}
"""
import base64
import io
import json
import re
import sys
import urllib.error
import urllib.request

from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PROMPT = """这是同一个微信聊天窗口的前后两帧（图1在前，图2在后）。
判断：图2 里有没有出现**新的消息**？

判据：
· 没有新消息 —— 只是同一张图片/表情包在动、在刷新帧；闪烁、头像、光标变了都不算；
· 有新消息 —— 出现了新的文字气泡、有人说了新的话、或者画面整体滚动了。

只输出 yes 或 no，然后跟一句不超过 15 字的理由。"""

MAX_WIDTH = 640


def encode(path):
    im = Image.open(path).convert("RGB")
    if im.width > MAX_WIDTH:
        im = im.resize((MAX_WIDTH, round(im.height * MAX_WIDTH / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=86)
    return base64.b64encode(buf.getvalue()).decode()


def parse(text):
    s = (text or "").strip().lower()
    if re.search(r"\byes\b", s) or "有新的" in s or "有新消息" in s:
        return True
    if re.search(r"\bno\b", s) or "没有" in s:
        return False
    return None


def main():
    prev = sys.argv[1]
    cur = sys.argv[2]
    model = sys.argv[3] if len(sys.argv) > 3 else "qwen3-vl:4b-instruct"
    url = sys.argv[4] if len(sys.argv) > 4 else "http://127.0.0.1:11434"

    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [encode(prev), encode(cur)],
        "stream": False,
        "keep_alive": "30m",
        "options": {"temperature": 0, "num_predict": 24, "num_ctx": 4096},
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            raw = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return

    text = raw.get("response") or ""
    new = parse(text)
    print(json.dumps({"ok": True, "new": new, "why": text.strip()[:60]}, ensure_ascii=False))


if __name__ == "__main__":
    main()