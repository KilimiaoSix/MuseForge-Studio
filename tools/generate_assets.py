from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter
import math
import random


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "apps" / "ui-prototype" / "prototype" / "assets"
ASSET_DIR.mkdir(parents=True, exist_ok=True)


PALETTES = [
    ((31, 35, 44), (86, 124, 142), (224, 188, 119), (214, 219, 226)),
    ((28, 26, 35), (113, 87, 132), (90, 180, 167), (232, 225, 213)),
    ((24, 31, 30), (72, 113, 91), (202, 159, 91), (236, 232, 218)),
    ((35, 29, 32), (154, 93, 86), (84, 138, 151), (238, 229, 210)),
    ((22, 26, 34), (92, 99, 137), (218, 167, 102), (226, 232, 237)),
]


def lerp(a, b, t):
    return int(a + (b - a) * t)


def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        for x in range(w):
            wobble = 0.035 * math.sin((x / w) * math.pi * 2)
            tt = min(1, max(0, t + wobble))
            px[x, y] = tuple(lerp(top[i], bottom[i], tt) for i in range(3))
    return img


def draw_art(path, seed, portrait=True):
    random.seed(seed)
    w, h = (720, 960) if portrait else (960, 720)
    p = PALETTES[seed % len(PALETTES)]
    img = gradient((w, h), p[0], p[1])
    draw = ImageDraw.Draw(img, "RGBA")

    # Background window or horizon shapes.
    for i in range(7):
        x0 = random.randint(-80, w - 100)
        y0 = random.randint(20, h - 180)
        x1 = x0 + random.randint(120, 260)
        y1 = y0 + random.randint(160, 360)
        color = (*p[1], random.randint(42, 72))
        draw.rounded_rectangle((x0, y0, x1, y1), radius=18, fill=color, outline=(*p[3], 25))

    # Rain / light streaks.
    for _ in range(90):
        x = random.randint(0, w)
        y = random.randint(0, h)
        length = random.randint(16, 44)
        draw.line((x, y, x - 6, y + length), fill=(*p[3], random.randint(28, 64)), width=1)

    # Character silhouette.
    cx = w // 2 + random.randint(-22, 22)
    face_y = int(h * 0.34)
    hair = (*p[3], 230)
    shadow = (24, 20, 24, 235)
    dress = (18, 17, 22, 245)
    skin = (233, 207, 181, 235)

    draw.ellipse((cx - 118, face_y - 150, cx + 118, face_y + 110), fill=hair)
    draw.ellipse((cx - 76, face_y - 80, cx + 76, face_y + 92), fill=skin)
    draw.polygon(
        [
            (cx - 150, int(h * 0.96)),
            (cx - 92, int(h * 0.54)),
            (cx + 92, int(h * 0.54)),
            (cx + 158, int(h * 0.96)),
        ],
        fill=dress,
    )
    draw.ellipse((cx - 52, face_y - 10, cx - 28, face_y + 8), fill=(45, 55, 66, 230))
    draw.ellipse((cx + 28, face_y - 10, cx + 52, face_y + 8), fill=(45, 55, 66, 230))
    draw.arc((cx - 32, face_y + 26, cx + 34, face_y + 58), 10, 170, fill=(145, 94, 99, 200), width=3)

    # Clothing highlights and ambient light.
    draw.line((cx - 82, int(h * 0.58), cx - 30, int(h * 0.94)), fill=(*p[2], 120), width=5)
    draw.line((cx + 88, int(h * 0.58), cx + 38, int(h * 0.94)), fill=(*p[2], 90), width=4)
    draw.ellipse((cx - 200, int(h * 0.17), cx + 220, int(h * 0.64)), outline=(*p[2], 65), width=5)

    # Subtle film grain.
    noise = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    nd = ImageDraw.Draw(noise, "RGBA")
    for _ in range(2600):
        x = random.randint(0, w - 1)
        y = random.randint(0, h - 1)
        a = random.randint(3, 16)
        nd.point((x, y), fill=(255, 255, 255, a))
    img = Image.alpha_composite(img.convert("RGBA"), noise)
    img = img.filter(ImageFilter.UnsharpMask(radius=1.3, percent=118, threshold=3))
    img.save(path)


def draw_lora(path, seed):
    random.seed(seed)
    w, h = 420, 420
    p = PALETTES[(seed + 2) % len(PALETTES)]
    img = gradient((w, h), p[0], p[1])
    draw = ImageDraw.Draw(img, "RGBA")
    cx = w // 2 + random.randint(-16, 16)
    cy = h // 2 + random.randint(-10, 12)
    draw.ellipse((cx - 112, cy - 146, cx + 112, cy + 112), fill=(*p[3], 220))
    draw.ellipse((cx - 72, cy - 72, cx + 72, cy + 72), fill=(232, 204, 178, 235))
    draw.polygon([(cx - 125, h), (cx - 70, cy + 70), (cx + 70, cy + 70), (cx + 125, h)], fill=(20, 18, 24, 245))
    draw.ellipse((cx - 42, cy - 10, cx - 22, cy + 7), fill=(42, 55, 69, 230))
    draw.ellipse((cx + 22, cy - 10, cx + 42, cy + 7), fill=(42, 55, 69, 230))
    for i in range(5):
        draw.line((cx - 100 + i * 48, cy - 122, cx - 86 + i * 44, cy + 110), fill=(*p[2], 55), width=3)
    img.filter(ImageFilter.UnsharpMask(radius=1.1, percent=120)).save(path)


for idx in range(1, 6):
    draw_art(ASSET_DIR / f"art-{idx:02d}.png", idx)

for idx in range(1, 7):
    draw_lora(ASSET_DIR / f"lora-{idx:02d}.png", idx)

print(f"Generated assets in {ASSET_DIR}")
