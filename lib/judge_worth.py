"""判断「刚来的这条新消息值不值得接一句」——纯文本、本地小模型、不花钱。

为什么要单独一步：读屏的那个 VL 只能看到整张截图，它不知道哪几条是"刚来的"。
它判的是"这一屏看起来热闹不热闹"，而模型被叫醒后看的是"新来的这一条"——
两边口味对不上，就会出现「判官说值得 → 叫醒 → 模型说这条没什么可接」的空转。

小模型（4b）光靠规则描述判不准，给几个例子就准了（实测 8/8）。

输入（stdin，JSON）：
  {"recent": ["上下文里的几行"], "fresh": ["这一轮新来的行"]}
输出（stdout，JSON）：
  {"ok": true, "verdict": "yes"|"no", "reason": "..."}
"""
import json
import re
import sys
import urllib.error
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PROMPT = """你在判断群聊里刚来的一条消息，值不值得接一句话。只输出 yes 或 no。

例1 新消息：「球球别抓我：开一把什么」→ no（顺着别人打游戏的问句，没什么可回）
例2 新消息：「球球别抓我：@升天肥鱼 你说是不是涨价了」→ yes（点名提问）
例3 新消息：「球球别抓我：图片：模糊熊猫脸，带微笑表情」→ no（表情包）
例4 新消息：「九星噩夜：我那块硬盘 4899 买的，刚用一周就降价了」→ yes（有内容，可以接话）
例5 新消息：「德师傅：对」→ no（短应答）
例6 新消息：「图片：动漫角色互动，蓝发少女被抱着」→ no（同人图，没配字也没点名）

{ctx}
现在判断：
新消息：「{fresh}」
只输出 yes 或 no。"""


def build(payload):
    recent = [str(x) for x in (payload.get("recent") or [])][-5:]
    fresh = [str(x) for x in (payload.get("fresh") or [])][-3:]
    ctx = ("最近这几条只是背景，不要评价它们：「" + "」「".join(recent) + "」\n") if recent else ""
    return PROMPT.format(ctx=ctx, fresh="」「".join(fresh))


def parse(text):
    s = (text or "").strip().lower()
    if re.search(r"\byes\b", s) or "值得" in s and "不值得" not in s:
        return "yes"
    if re.search(r"\bno\b", s) or "不值得" in s:
        return "no"
    return None


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "qwen3-vl:4b-instruct"
    url = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:11434"
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"stdin 不是 JSON: {e}"}, ensure_ascii=False))
        return

    body = {
        "model": model,
        "prompt": build(payload),
        "stream": False,
        "keep_alive": "30m",
        "options": {"temperature": 0, "num_predict": 8, "num_ctx": 2048},
    }
    req = urllib.request.Request(
        url.rstrip("/") + "/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            resp = json.loads(r.read().decode())
    except urllib.error.URLError as e:
        print(json.dumps({"ok": False, "error": f"ollama 连不上: {e}"}, ensure_ascii=False))
        return

    raw = (resp.get("response") or "").strip()
    verdict = parse(raw)
    print(json.dumps({
        "ok": verdict is not None,
        "verdict": verdict,
        "reason": raw[:40],
        "model": model,
        "outputTokens": resp.get("eval_count"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
