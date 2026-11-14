"""
页面探针：只看像素，判断当前是微信的哪一页（不 OCR，约 30ms）。

为什么要它：微信把无障碍树封了（uiautomator dump 只有一个空节点），
"现在在列表还是会话页"只能看画面。以前读顶部「微信」两个字要 1.5 秒，
其实看几块像素就够了。

判据（都按相对坐标，实测 1080×2160）：

  1. 整张图不是白底 → 桌面/别的应用（微信页面几乎全白）
  2. 底部有四个并排的图标簇（tab 栏）→ 微信主页面：
       四个簇都在 = 聊天列表 / 通讯录 / 发现 / 我
       哪一簇的图标是绿色（#07C160）= 当前是哪个 tab
     （会话页底部是输入栏，中间两簇是白的，所以第 2、3 簇为空）
  3. 不是 tab 页、左上角有返回箭头、底部中间两簇为空 → 会话页
  4. 不是 tab 页、顶部一条很宽的浅灰搜索框 → 搜索页
  5. 都不是 → other

用法：python page_probe.py <png>
输出：{"ok":true,"page":"list|tab|chat|search|other","tab":0..3|null,...}
"""
import json
import sys

from PIL import Image


def main():
    png = sys.argv[1]
    im = Image.open(png).convert("RGB")
    W, H = im.size
    px = im.load()

    def ink(xa, xb, ya, yb, thr=130, step=2):
        n = 0
        t = 0
        for y in range(int(ya), int(yb), step):
            for x in range(int(xa), int(xb), step):
                t += 1
                r, g, b = px[x, y]
                if r < thr and g < thr and b < thr:
                    n += 1
        return n / t if t else 0.0

    def light(xa, xb, ya, yb, thr=225, step=5):
        n = 0
        t = 0
        for y in range(int(ya), int(yb), step):
            for x in range(int(xa), int(xb), step):
                t += 1
                r, g, b = px[x, y]
                if r > thr and g > thr and b > thr:
                    n += 1
        return n / t if t else 0.0

    def is_green(r, g, b):
        return g > 140 and r < 120 and b < 140 and g - r > 40 and g - b > 30

    # 1) 白底比例（避开状态栏和底部导航条）
    white = light(0, W, H * 0.12, H * 0.90)
    if white < 0.45:
        print(json.dumps({"ok": True, "page": "other", "tab": None, "white": round(white, 3)}))
        return

    # 2) 底部四个 tab 簇：分别看有没有深色墨迹
    cols = []
    for i in range(4):
        xa = W * (0.06 + i * 0.25)
        cols.append(round(ink(xa, xa + W * 0.13, H * 0.945, H * 0.972), 3))
    # tab 栏的底色是白的；如果底部压着黑色导航条/键盘，那不是 tab 栏
    strip_light = light(0, W, H * 0.945, H * 0.972)
    tab_like = len([c for c in cols if c > 0.02]) >= 3 and strip_light > 0.5

    tab = None
    if tab_like:
        green = []
        for i in range(4):
            gx0, gx1 = int(W * i / 4), int(W * (i + 1) / 4)
            cnt = 0
            for y in range(int(H * 0.945), int(H * 0.972), 3):
                for x in range(gx0, gx1, 3):
                    if is_green(*px[x, y]):
                        cnt += 1
            green.append(cnt)
        if max(green) >= 12:
            tab = green.index(max(green))

    # 3) 顶部：返回箭头 / 三点 / 搜索框
    back = ink(W * 0.02, W * 0.09, H * 0.030, H * 0.080)
    dots = ink(W * 0.88, W * 0.98, H * 0.035, H * 0.075)
    search_bar = light(W * 0.15, W * 0.85, H * 0.045, H * 0.085) > 0.5

    if tab_like:
        page = "list" if tab == 0 else "tab"
    elif back > 0.02 and cols[1] < 0.01:
        page = "chat"
    elif search_bar:
        page = "search"
    else:
        page = "other"

    print(json.dumps({
        "ok": True,
        "page": page,
        "tab": tab,
        "white": round(white, 3),
        "cols": cols,
        "back": round(back, 3),
        "dots": round(dots, 3),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e), "page": "unknown"}, ensure_ascii=False))