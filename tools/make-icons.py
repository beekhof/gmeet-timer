#!/usr/bin/env python3
"""Regenerate icons/icon{16,32,48,128}.png.

Draws a dark rounded square with a clock face, using the same accent colours as
the overlay in content.js. Rendered at 8x and downsampled so the small sizes
stay legible.

    python3 tools/make-icons.py
"""

import os
from PIL import Image, ImageDraw

BG = (26, 26, 28, 255)        # overlay background
FACE = (138, 180, 248, 255)   # .fill blue
HAND = (26, 26, 28, 255)
DOT = (229, 57, 53, 255)      # .dot red

SIZES = (16, 32, 48, 128)
SCALE = 8
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")


def draw(size: int) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square background.
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=BG)

    # Clock face.
    pad = s * 0.18
    d.ellipse([pad, pad, s - pad, s - pad], fill=FACE)

    # Hands: 10:10-ish, thick enough to survive the 16px downsample.
    cx = cy = s / 2
    w = max(2, int(s * 0.065))
    d.line([cx, cy, cx, cy - s * 0.23], fill=HAND, width=w)          # minute hand (up)
    d.line([cx, cy, cx + s * 0.16, cy + s * 0.08], fill=HAND, width=w)  # hour hand
    r = w * 0.7
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=HAND)

    # Recording dot, bottom-right, echoing the overlay's red dot.
    dr = s * 0.15
    dx, dy = s - dr - s * 0.09, s - dr - s * 0.09
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=BG)
    dr *= 0.68
    d.ellipse([dx - dr, dy - dr, dx + dr, dy + dr], fill=DOT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT, f"icon{size}.png")
        draw(size).save(path)
        print("wrote", path)


if __name__ == "__main__":
    main()
