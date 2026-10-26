# -*- coding: utf-8 -*-
"""
fetch_and_tint.py —— 地形瓦片本地化（一步到位）
1) 下载全球 z3~z4 瓦片 + 中国 z5~z8 瓦片
2) 把原来靠 CSS 滤镜做的染色「烘焙」进图片本身
   （这样关掉 CSS 滤镜后，本地瓦片和原来的观感完全一致）
"""
import os, math, io, time, sys
import urllib.request
from PIL import Image, ImageEnhance

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'assets', 'terrain')
SRC = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/{z}/{y}/{x}'
UA = {'User-Agent': 'aq-board-terrain/1.0'}

# 与 CSS 里一致：grayscale(.8) brightness(.72) contrast(1.08) hue-rotate(170deg) saturate(1.35)
GRAY = 0.8
BRIGHT = 0.72
CONTRAST = 1.08
HUE = 170.0
SAT = 1.35


def tile_range(z, bbox):
    n = 2 ** z
    w, e, s, nn = bbox
    x0 = int(math.floor((w + 180) / 360 * n))
    x1 = int(math.floor((e + 180) / 360 * n))
    y0 = int(math.floor((0.5 - math.log((1 + math.sin(math.radians(nn))) / (1 - math.sin(math.radians(nn)))) / (4 * math.pi)) * n))
    y1 = int(math.floor((0.5 - math.log((1 + math.sin(math.radians(s))) / (1 - math.sin(math.radians(s)))) / (4 * math.pi)) * n))
    return x0, x1, y0, y1


def fetch(z, x, y, path):
    if os.path.exists(path) and os.path.getsize(path) > 200:
        return 'skip'
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for i in range(3):
        try:
            req = urllib.request.Request(SRC.format(z=z, y=y, x=x), headers=UA)
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read()
            if len(data) < 200:
                raise IOError('too small')
            with open(path, 'wb') as f:
                f.write(data)
            return 'ok'
        except Exception as e:
            time.sleep(0.4 * (i + 1))
    return 'fail'


def hue_matrix(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ]


def sat_matrix(k):
    return [
        [0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k],
        [0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k],
        [0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k],
    ]


def mul(m, p):
    return [
        m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2],
        m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2],
        m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2],
    ]


HUE_M = hue_matrix(HUE)
SAT_M = sat_matrix(SAT)


def tint_pixel(r, g, b):
    # grayscale(.8)
    lum = 0.213 * r + 0.715 * g + 0.072 * b
    r = r * (1 - GRAY) + lum * GRAY
    g = g * (1 - GRAY) + lum * GRAY
    b = b * (1 - GRAY) + lum * GRAY
    # brightness
    r, g, b = r * BRIGHT, g * BRIGHT, b * BRIGHT
    # contrast
    r = (r - 128) * CONTRAST + 128
    g = (g - 128) * CONTRAST + 128
    b = (b - 128) * CONTRAST + 128
    # hue rotate → saturate
    r, g, b = mul(HUE_M, [r, g, b])
    r, g, b = mul(SAT_M, [r, g, b])
    return max(0, min(255, int(r))), max(0, min(255, int(g))), max(0, min(255, int(b)))


def tint_file(path):
    try:
        im = Image.open(path).convert('RGB')
    except Exception:
        return 'bad'
    # 用查找表加速（三通道各自独立映射不成立，这里直接逐像素，2048 张可接受）
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            px[x, y] = tint_pixel(r, g, b)
    im.save(path, optimize=True)
    return 'ok'


def main():
    jobs = []
    # 全球 z3~z4
    for z in (3, 4):
        x0, x1, y0, y1 = tile_range(z, (-180, 180, -60, 78))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                jobs.append((z, x, y))
    # 中国 z5~z8
    for z in range(5, 9):
        x0, x1, y0, y1 = tile_range(z, (73, 135, 18, 54))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                jobs.append((z, x, y))

    print('待处理瓦片：%d' % len(jobs))
    ok = skip = fail = 0
    for idx, (z, x, y) in enumerate(jobs):
        path = os.path.join(OUT, str(z), str(x), '%d.png' % y)
        r = fetch(z, x, y, path)
        if r == 'ok':
            ok += 1
        elif r == 'skip':
            skip += 1
        else:
            fail += 1
        if idx % 100 == 0:
            sys.stdout.write('\r下载 %d/%d  新增%d 跳过%d 失败%d' % (idx + 1, len(jobs), ok, skip, fail))
            sys.stdout.flush()
    print('\n下载完成：新增 %d / 跳过 %d / 失败 %d' % (ok, skip, fail))

    if 'notint' in sys.argv:
        print('跳过染色（保留原始瓦片，染色交给浏览器 CSS）')
        return

    # 统一染色（已染过的跳过：用一个标记文件记录）
    flag = os.path.join(OUT, '.tinted_v1')
    if os.path.exists(flag):
        print('已经染过色，跳过')
        return
    total = 0
    for root, dirs, files in os.walk(OUT):
        for f in files:
            if f.endswith('.png'):
                total += 1
    print('开始染色 %d 张…' % total)
    done = 0
    for root, dirs, files in os.walk(OUT):
        for f in files:
            if not f.endswith('.png'):
                continue
            tint_file(os.path.join(root, f))
            done += 1
            if done % 50 == 0:
                sys.stdout.write('\r染色 %d/%d' % (done, total))
                sys.stdout.flush()
    open(flag, 'w').write('1')
    print('\n染色完成')


if __name__ == '__main__':
    main()
