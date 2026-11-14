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
4. 图片/表情包/贴纸的消息，内容写「图片：<20 字内说明主体、动作、场景、有没有配字>」。
5. 引用别人消息的，内容写「引用：<被引用的昵称> <原文摘要>」。
6. 语音写「语音：<时长>」；红包/转账写「红包：<金额>」。
7. 只输出这些行，不要解释、不要编号、不要空行。
8. 昵称必须是真实昵称（气泡上方那行灰字）：看不清或没有，就沿用上一个真实昵称。绝不能写「昵称」「群友」「某人」这类占位词。
9. 最末尾单独再输出一行，判断「这一屏最新的内容值不值得有人接一句话」：
判断｜值得回
或者
判断｜不值得回
判断标准（只看最近的几条，且要把文字和图片放在一起看）：
· 值得回 —— 有人提问、点名、认真在说事、发了有意思/有话可接的图、明显想让人接话、有值得回应的新信息；
· 不值得回 —— 别人之间的闲聊、短应答（对、嗯、好的）、复读、系统提示、糊得看不清的图。

⚠ 图片可以值得回（有人画的、有意思的、带梗的），但**同一张图/同一段动图只算一次**：
  如果屏幕上的图跟刚才那批基本一样、只是动图换了帧，就写「不值得回」。
拿不准就写「不值得回」。"""



TITLE_RE = re.compile(r"^(群名|标题|TITLE)\s*[｜|:：=]\s*(.+)$", re.I)
VERDICT_RE = re.compile(r"^(判断|结论|VERDICT)\s*[｜|:：=]\s*(.+)$", re.I)


def split_lines(raw):
    """把模型输出拆成 (nick, content)；标题行单独返回。"""
    rows, title = [], ""
    verdict = None
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
        vm = VERDICT_RE.match(s)
        if vm:
            body = vm.group(2)
            if "不值得" in body:
                verdict = "no"
            elif "值得" in body:
                verdict = "yes"
            else:
                verdict = None
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
    return rows, title, verdict


def main():
    png = sys.argv[1]
    x = max(0, int(sys.argv[2]))
    y = max(0, int(sys.argv[3]))
    w = int(sys.argv[4])
    h = int(sys.argv[5])
    max_width = int(sys.argv[6]) if len(sys.argv) > 6 else 720
    model = sys.argv[7] if len(sys.argv) > 7 else "qwen3-vl:4b-instruct"
    url = sys.argv[8] if len(sys.argv) > 8 else "http://127.0.0.1:11434"
    # 第 9 个参数：上一帧识别出来的内容（JSON 数组）。给了就让她自己对比，
    # 同一张图/表情包在动的时候，别每帧都当成新东西重新描述。
    prev_lines = []
    if len(sys.argv) > 9 and sys.argv[9].strip():
        try:
            prev_lines = [str(x) for x in json.loads(sys.argv[9])][-14:]
        except Exception:
            prev_lines = []

    im = Image.open(png).convert("RGB")
    w = min(w, im.width - x)
    h = min(h, im.height - y)
    im = im.crop((x, y, x + w, y + h))
    if max_width and im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)

    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode()

    prompt = PROMPT
    if prev_lines:
        prompt += (
            "\n\n上一帧识别到的内容（只用来对比，不要照抄）：\n"
            + "\n".join("  " + x[:60] for x in prev_lines)
            + "\n\n对比规则（重要）：\n"
            "· 如果这一帧里的某张图片/表情和上一帧是同一张（位置和内容看起来一样），"
            "内容就写「图片：与上一帧相同」，不要重新描述它 —— 它在动、在换帧都不算新消息。\n"
            "· 如果这一帧相对上一帧没有出现新的文字、也没有新的图，最后那行判断必须写「判断｜不值得回」。\n"
            "· 只有真的出现了新消息（新文字气泡、新图、有人 @ 你），才判「值得回」。"
        )

    payload = {
        "model": model,
        "prompt": prompt,
        "images": [b64],
        "stream": False,
        "keep_alive": "30m",
        # num_ctx 必须和 judge_worth.py 一致，否则 Ollama 会当成两份配置、每帧来回重载。
        # 4096 够用（图 ~1500 tok + prompt + 输出 1100），且能整份塞进 6GB 显存（100% GPU）；
        # 8192 会把模型顶到 4.8GB，24% 溢出到 CPU，单帧从 2.1 秒变 3.4 秒。
        "options": {"temperature": 0, "num_predict": 1100, "num_ctx": 4096},
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

    rows, title, verdict = split_lines(resp.get("response") or "")
    lines = []
    last_nick = None
    # 模型偶尔把格式里的「昵称」二字照抄出来当昵称（占位符）。那不是名字，
    # 遇到就沿用上一个真实昵称，否则她会看到「昵称：在吗」，根本不知道谁说的。
    PLACEHOLDER = {"昵称", "群友", "某人", "未知", "对方", "用户", "发信人"}
    for nick, content in rows:
        if nick and nick.strip(" ：:") in PLACEHOLDER:
            nick = last_nick
        elif nick:
            last_nick = nick
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
        "verdict": verdict,
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
