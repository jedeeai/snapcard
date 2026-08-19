#!/usr/bin/env python3
"""Generate SnapCard extension icons (16/48/128 px).

Design: white rounded-square base, blue camera outline (no red/green — the
project owner is red-green color blind, so all accent color is a single blue).
Run: python3 icons/gen_icons.py
"""
import os
from PIL import Image, ImageDraw

BLUE = (29, 155, 240, 255)  # X-brand blue, colorblind-neutral single accent
WHITE = (255, 255, 255, 255)
BORDER = (235, 238, 240, 255)  # faint neutral border so 16px icon reads on white toolbars

SIZES = [16, 48, 128]
OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def draw_camera(size: int) -> Image.Image:
    # Supersample for smooth curves, then downscale.
    scale = 8
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded square base.
    radius = int(s * 0.22)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=WHITE, outline=BORDER, width=max(1, s // 64))

    # Camera body outline.
    pad = s * 0.22
    body_top = s * 0.38
    body = [pad, body_top, s - pad, s * 0.82]
    stroke = max(2, s // 22)
    d.rounded_rectangle(body, radius=int(s * 0.08), outline=BLUE, width=stroke)

    # Viewfinder bump on top-left of the body.
    bump_w = s * 0.22
    bump_h = s * 0.09
    bump_x0 = pad + s * 0.08
    d.rounded_rectangle(
        [bump_x0, body_top - bump_h, bump_x0 + bump_w, body_top + stroke / 2],
        radius=int(bump_h * 0.4),
        outline=BLUE,
        width=stroke,
    )

    # Lens circle (outline only, keeps it a "camera" glyph not a filled blob).
    cx, cy = s / 2, (body_top + s * 0.82) / 2 + s * 0.02
    r = s * 0.16
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=BLUE, width=stroke)
    r2 = r * 0.42
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=BLUE)

    return img.resize((size, size), Image.LANCZOS)


def main():
    for size in SIZES:
        icon = draw_camera(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        icon.save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
