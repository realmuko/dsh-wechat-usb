"""比较两帧截图，找出「哪一段在变」。

用途：认出一张**动图**。
微信里动图每帧都在变，但**只在同一个气泡里变**；而新消息会出现在底部、或者让整屏滚动。
所以只要看"变化的行落在哪一段"，就能把两者分开 —— 不靠时间窗，也不靠文字位置。

输出（stdout，JSON）：
  {"ok": true, "band": [y0, y1], "ratio": 0.08, "rows": 540}
  band 是变化行在**裁切区域内的相对坐标**（0 ~ rows）；没有变化时 band 为 null。

用法：
  python frame_diff.py <a.png> <b.png> <x> <y> <w> <h> [maxWidth] [skipBottomPx]
"""
import json
import sys

from PIL import Image, ImageChops, ImageStat

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 一行"算变了"的阈值（0~255，下采样后的灰度平均差）
ROW_THRESHOLD = 6
# 变化行占比低于这个数，当作没变（噪点 / 压缩抖动）
MIN_CHANGED_ROWS = 3


def load(png, x, y, w, h, max_width, skip_bottom):
    im = Image.open(png).convert("L")
    w = min(w, im.width - x)
    h = min(h, im.height - y)
    im = im.crop((x, y, x + w, y + h))
    # 输入框区域有光标闪烁，别让它冒充"新消息"
    if skip_bottom > 0 and im.height > skip_bottom:
        im = im.crop((0, 0, im.width, im.height - skip_bottom))
    if max_width and im.width > max_width:
        im = im.resize((max_width, max(1, round(im.height * max_width / im.width))), Image.BILINEAR)
    return im


def main():
    a_png, b_png = sys.argv[1], sys.argv[2]
    x = max(0, int(sys.argv[3]))
    y = max(0, int(sys.argv[4]))
    w = int(sys.argv[5])
    h = int(sys.argv[6])
    max_width = int(sys.argv[7]) if len(sys.argv) > 7 else 270
    skip_bottom = int(sys.argv[8]) if len(sys.argv) > 8 else 130

    a = load(a_png, x, y, w, h, max_width, skip_bottom)
    b = load(b_png, x, y, w, h, max_width, skip_bottom)
    if a.size != b.size:
        print(json.dumps({"ok": False, "error": "尺寸不一致", "band": None}, ensure_ascii=False))
        return

    diff = ImageChops.difference(a, b)
    # 每行的**平均**差（不是最大值）：动图那种整块变化会很明显，噪点不会
    rows = a.height
    row_means = []
    for i in range(rows):
        strip = diff.crop((0, i, a.width, i + 1))
        stat = ImageStat.Stat(strip)
        row_means.append(stat.mean[0])

    changed = [i for i, m in enumerate(row_means) if m > ROW_THRESHOLD]
    if len(changed) < MIN_CHANGED_ROWS:
        print(json.dumps({"ok": True, "band": None, "ratio": 0.0, "rows": rows}, ensure_ascii=False))
        return

    y0, y1 = changed[0], changed[-1] + 1
    print(json.dumps({
        "ok": True,
        "band": [y0, y1],
        "ratio": round(len(changed) / rows, 3),
        "span": round((y1 - y0) / rows, 3),
        "rows": rows,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "band": None}, ensure_ascii=False))
