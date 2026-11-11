#!/usr/bin/env python
"""生成 assets/ 下三张坐标示意图（chat/list/search）。

真实手机截图含群名、成员昵称和聊天内容，不适合公开仓库；这个脚本用合成内容
重画同尺寸（1080x2160）示意图，保留 1/2/3 坐标标注，坐标与 wechat-usb.config.json
的默认值一致。重新生成：

    python scripts/gen-demo-assets.py
"""

import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
W, H = 1080, 2160

DARK = (25, 25, 25)
GRAY = (150, 150, 150)
LIGHT = (245, 245, 245)
LINE = (232, 232, 232)
GREEN = (7, 193, 96)
BUBBLE = (149, 236, 105)
RED = (224, 26, 26)
BLUE = (76, 132, 208)

FONT_DIR = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
FONT_REG = os.path.join(FONT_DIR, "msyh.ttc")
FONT_BOLD = os.path.join(FONT_DIR, "msyhbd.ttc")


def font(size, bold=False):
    path = FONT_BOLD if bold else FONT_REG
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def text(d, xy, s, size=34, fill=DARK, bold=False, anchor="la"):
    d.text(xy, s, font=font(size, bold), fill=fill, anchor=anchor)


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def status_bar(d):
    text(d, (48, 26), "9:41", 34, DARK, True)
    # 信号 / 电池的简化画法
    for i in range(4):
        h = 10 + i * 6
        d.rectangle((650 + i * 16, 60 - h, 660 + i * 16, 60), fill=DARK)
    d.rectangle((740, 32, 802, 58), outline=DARK, width=3)
    d.rectangle((746, 38, 788, 52), fill=DARK)
    d.rectangle((804, 40, 810, 50), fill=DARK)


def avatar(d, box, color):
    rounded(d, box, 18, fill=color)
    x0, y0, x1, y1 = box
    d.ellipse((x0 + 26, y0 + 16, x1 - 26, y0 + 58), fill=(255, 255, 255))
    d.ellipse((x0 + 14, y0 + 66, x1 - 14, y1 - 6), fill=(255, 255, 255))


def tab_bar(d):
    d.rectangle((0, H - 150, W, H), fill=(247, 247, 247))
    d.line((0, H - 150, W, H - 150), fill=LINE, width=2)
    labels = ["微信", "通讯录", "发现", "我"]
    for i, s in enumerate(labels):
        cx = int(W * (i + 0.5) / 4)
        d.ellipse((cx - 26, H - 116, cx + 26, H - 64), outline=GREEN if i == 0 else GRAY, width=4)
        text(d, (cx, H - 54), s, 28, GREEN if i == 0 else GRAY, anchor="mm")


def annotation_ring(d, cx, cy, r):
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=RED, width=6)


def annotation_label(d, x, y, label):
    f = font(36, True)
    tw = d.textlength(label, font=f)
    d.rectangle((x, y, x + tw + 32, y + 58), fill=RED)
    text(d, (x + 16, y + 29), label, 36, (255, 255, 255), True, anchor="lm")


def draw_list():
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    status_bar(d)
    text(d, (W // 2, 112), "微信", 44, DARK, True, anchor="mm")
    # 搜索图标（配置 coords.searchIcon = 888,88）
    d.ellipse((888 - 22, 88 - 22, 888 + 22, 88 + 22), outline=DARK, width=5)
    d.line((888 + 16, 88 + 16, 888 + 40, 88 + 40), fill=DARK, width=6)
    # 右上角 +
    d.ellipse((1010 - 4, 88 - 4, 1010 + 4, 88 + 4), outline=DARK, width=4)
    d.rectangle((1010 - 20, 88 - 24, 1010 + 20, 88 + 24), outline=DARK, width=4)

    # 导入提示条
    d.rectangle((0, 212, W, 334), fill=(247, 247, 247))
    text(d, (128, 273), "可从其它设备导入聊天记录到此设备", 34, (110, 110, 110), anchor="lm")

    rows = [
        ("示例联系人", "你好，这是一条示例消息", "9:30", BLUE),
        ("示例群聊(3)", "[示例] 大家好", "9:05", (196, 164, 92)),
        ("家人群", "周末回家吃饭吗", "昨天", (120, 170, 120)),
    ]
    y = 366
    for name, preview, when, color in rows:
        avatar(d, (40, y, 140, y + 100), color)
        text(d, (176, y + 8), name, 40, DARK, True)
        text(d, (176, y + 58), preview, 32, GRAY)
        text(d, (W - 40, y + 10), when, 28, GRAY, anchor="ra")
        d.line((176, y + 132, W, y + 132), fill=LINE, width=2)
        y += 190

    tab_bar(d)
    annotation_ring(d, 888, 88, 40)
    annotation_label(d, 690, 132, "1 搜索图标")
    return img


def draw_search():
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    status_bar(d)
    text(d, (60, 132), "‹", 84, DARK, anchor="lm")
    # 搜索框（配置 coords.searchField = 570,160）
    rounded(d, (110, 96, 1010, 224), 28, fill=(242, 242, 242))
    d.ellipse((150, 136, 186, 172), outline=(120, 120, 120), width=4)
    d.line((182, 168, 202, 188), fill=(120, 120, 120), width=5)
    text(d, (224, 160), "示例群聊", 38, DARK, anchor="lm")
    d.line((224, 184, 372, 184), fill=DARK, width=2)
    d.ellipse((942, 142, 978, 178), outline=(150, 150, 150), width=3)

    text(d, (40, 264), "群聊", 30, GRAY)

    # 第一条结果（配置 coords.firstResult = 350,438）
    avatar(d, (40, 330, 150, 440), (196, 164, 92))
    d.text((190, 356), "示例", font=font(44), fill=GREEN)
    text(d, (290, 356), "群聊(3)", 44, DARK)
    text(d, (190, 420), "共 3 条相关聊天记录", 28, GRAY)
    d.line((40, 490, W, 490), fill=LINE, width=2)

    # 搜索建议
    tips = ["示例", "示例图片", "示例表情包", "示例文件", "示例聊天记录"]
    y = 600
    for s in tips:
        d.ellipse((56, y + 12, 88, y + 44), outline=(130, 130, 130), width=4)
        d.line((84, y + 40, 100, y + 56), fill=(130, 130, 130), width=5)
        text(d, (130, y + 28), s, 38, DARK, anchor="lm")
        text(d, (W - 50, y + 28), "›", 48, (190, 190, 190), anchor="rm")
        d.line((40, y + 88, W, y + 88), fill=LINE, width=2)
        y += 130

    d.rectangle((0, H - 90, W, H), fill=(240, 240, 240))
    text(d, (W // 2, H - 45), "ADB Keyboard {ON}", 30, (110, 110, 110), anchor="mm")

    annotation_ring(d, 570, 160, 36)
    annotation_label(d, 620, 240, "2 搜索框")
    d.ellipse((350 - 70, 438 - 70, 350 + 70, 438 + 70), outline=RED, width=6)
    annotation_label(d, 40, 500, "3 第一条结果")
    return img


def draw_chat():
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    status_bar(d)
    text(d, (60, 120), "‹", 84, DARK, anchor="lm")
    text(d, (W // 2, 110), "示例群聊(3)", 44, DARK, True, anchor="mm")

    # 时间分隔
    text(d, (W // 2, 300), "晚上 8:37", 26, GRAY, anchor="mm")

    # 对方消息
    avatar(d, (36, 360, 136, 460), (196, 164, 92))
    text(d, (160, 344), "示例成员", 26, GRAY)
    rounded(d, (160, 386, 760, 486), 18, fill=(255, 255, 255), outline=LINE, width=2)
    text(d, (192, 436), "这是一条示例消息，用来演示坐标。", 32, DARK, anchor="lm")

    # 我的消息（绿色）
    rounded(d, (400, 540, 890, 640), 18, fill=BUBBLE)
    text(d, (432, 590), "收到，这是示例回复。", 32, DARK, anchor="lm")
    avatar(d, (910, 540, 1010, 640), BLUE)

    # 图片消息占位
    rounded(d, (160, 700, 560, 940), 16, fill=(232, 238, 245))
    text(d, (360, 820), "图片示例", 32, (130, 140, 150), anchor="mm")

    # 输入栏
    d.rectangle((0, 1930, W, H), fill=(247, 247, 247))
    d.line((0, 1930, W, 1930), fill=LINE, width=2)
    d.ellipse((28, 2000, 100, 2072), outline=(90, 90, 90), width=5)
    rounded(d, (130, 1975, 900, 2105), 24, fill=(255, 255, 255), outline=LINE, width=2)
    text(d, (170, 2040), "示例输入内容", 34, (120, 120, 120), anchor="lm")
    d.line((170, 2062, 470, 2062), fill=GREEN, width=3)
    # 发送按钮（配置 coords.send = 984,2030）
    rounded(d, (912, 1980, 1056, 2080), 14, fill=GREEN)
    text(d, (984, 2030), "发送", 36, (255, 255, 255), True, anchor="mm")

    annotation_ring(d, 400, 2075, 42)
    annotation_label(d, 60, 1900, "1 输入框")
    annotation_ring(d, 984, 2030, 52)
    annotation_label(d, 700, 1750, "2 发送")
    return img


def main():
    os.makedirs(ASSETS, exist_ok=True)
    for name, fn in (("list", draw_list), ("search", draw_search), ("chat", draw_chat)):
        img = fn()
        out = os.path.join(ASSETS, f"{name}.png")
        img.save(out, "PNG", optimize=True)
        print(f"wrote {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
