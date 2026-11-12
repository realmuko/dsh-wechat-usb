"""用本地小模型（默认 qwen3-vl:4b-instruct，走 Ollama）当 OCR：把聊天区截图读成逐行消息。

输出格式与 ocr_rapid.py 一致：{"ok": true, "lines": [{text, x, y, w, h, score}]}
—— 这样 poller 的差分/去重逻辑不用改，只是识别引擎换了。

用法：
  python vl_ocr.py <png> <x> <y> <w> <h> <maxWidth> <model> <url>
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

PROMPT = """这是安卓微信聊天窗口的截图（手机状态栏、时间分隔一律忽略）。

第一行只输出窗口标题：原文照抄顶部居中的群名/联系人名，格式举例：
群名｜示例群聊(23)

从第二行开始，逐条转录聊天区里的消息，每条一行，格式：
昵称｜内容

规则：
1. 昵称取气泡上方那行灰色小字；没有小字，说明和上一条是同一个人，沿用上一个昵称。
2. 右侧绿色气泡（我自己发的）的昵称一律写「我」。
3. 文字原样转录：不要改写、不要合并相邻消息、不要总结、不要补标点。
4. 图片/表情包/贴纸的消息，内容写「图片：<20 字内说明主体、动作、场景、有没有配字>」，末尾再加「｜值得:是」或「｜值得:否」：
   · 值得:是 —— 有人专门画的/专门发给谁的、带明确文字信息的、点名或提问的、明显想让人接话的；
   · 值得:否 —— 游戏界面截图、进度条、表情包、随手转的网图、系统提示、糊得看不清的图。
5. 引用别人消息的，内容写「引用：<被引用的昵称> <原文摘要>」。
6. 语音写「语音：<时长>」；红包/转账写「红包：<金额>」。
7. 只输出这些行，不要解释、不要编号、不要空行。"""


TITLE_RE = re.compile(r"^(群名|标题|TITLE)\s*[｜|:：=]\s*(.+)$", re.I)


def split_lines(raw):
    """把模型输出拆成 (nick, content)；标题行单独返回。"""
    rows, title = [], ""
    for line in (raw or "").splitlines():
        s = line.strip()
        if not s:
            continue
        for lead in ("- ", "* ", "· "):
            if s.startswith(lead):
                s = s[len(lead):].strip()
        s = s.lstrip("0123456789.、）) ").strip()
        m = TITLE_RE.match(s)
        if m:
            title = m.group(2).strip()
            continue
        if "｜" not in s and "|" not in s:
            rows.append((None, s))
            continue
        sep = "｜" if "｜" in s else "|"
        nick, content = s.split(sep, 1)
        nick, content = nick.strip(), content.strip()
        content = content.replace("<", "").replace(">", "").replace("《", "").replace("》", "").strip()
        if not content:
            continue
        rows.append((nick or None, content))
    return rows, title


def main():
    png = sys.argv[1]
    x = max(0, int(sys.argv[2]))
    y = max(0, int(sys.argv[3]))
    w = int(sys.argv[4])
    h = int(sys.argv[5])
    max_width = int(sys.argv[6]) if len(sys.argv) > 6 else 720
    model = sys.argv[7] if len(sys.argv) > 7 else "qwen3-vl:4b-instruct"
    url = sys.argv[8] if len(sys.argv) > 8 else "http://127.0.0.1:11434"

    im = Image.open(png).convert("RGB")
    w = min(w, im.width - x)
    h = min(h, im.height - y)
    im = im.crop((x, y, x + w, y + h))
    if max_width and im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode()

    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [b64],
        "stream": False,
        "keep_alive": "30m",
        "options": {"temperature": 0, "num_predict": 700, "num_ctx": 8192},
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=150) as r:
            resp = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        print(json.dumps({"ok": False, "error": f"ollama 连不上: {e}", "lines": []}, ensure_ascii=False))
        return

    rows, title = split_lines(resp.get("response") or "")
    lines = []
    for nick, content in rows:
        text = f"{nick}：{content}" if nick else content
        lines.append({
            "text": text,
            "x": 0,
            "y": 200 + len(lines) * 30,   # VLM 不给坐标，用序号当纵坐标，保证顺序稳定
            "w": w,
            "h": 30,
            "score": 1.0,
        })
    print(json.dumps({
        "ok": True,
        "lines": lines,
        "title": title,
        "engine": "vl",
        "model": model,
        "imageTokens": resp.get("prompt_eval_count"),
        "outputTokens": resp.get("eval_count"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "lines": []}, ensure_ascii=False))
