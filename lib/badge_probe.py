"""数红点：聊天列表里「有未读」的会话，头像右上角有红色圆点。

Windows OCR 读不出那个红底白字的小数字（实测整列返回空），所以改成看像素：
在每行的头像区域里数红色像素，超过阈值就算「有未读」。

用法：
  python badge_probe.py <png> <y0> <y1> [<y0> <y1> ...]
输出：
  {"ok": true, "red": [312, 0, 280, ...]}   # 与传入的 y 段一一对应
"""
import json
import sys

from PIL import Image

RED_R = 180
RED_G = 90
RED_B = 90
# 头像列（避开左边的空白和右边的文字）
X0, X1 = 110, 190  # 头像右上角那块，红点就在这儿


def main():
    png = sys.argv[1]
    nums = [int(v) for v in sys.argv[2:]]
    im = Image.open(png).convert("RGB")
    out = []
    for i in range(0, len(nums) - 1, 2):
        y0 = max(0, min(nums[i], nums[i + 1]))
        y1 = min(im.height, max(nums[i], nums[i + 1]))
        if y1 - y0 < 8:
            out.append(0)
            continue
        box = im.crop((X0, y0, X1, y1))
        px = box.load()
        w, h = box.size
        red = 0
        for y in range(0, h, 2):
            for x in range(0, w, 2):
                r, g, b = px[x, y]
                if r > RED_R and g < RED_G and b < RED_B:
                    red += 1
        out.append(red)
    print(json.dumps({"ok": True, "red": out}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e), "red": []}, ensure_ascii=False))