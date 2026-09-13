"""Generate the extension's icon set.

Kept as a script rather than as four checked-in binaries nobody can edit: the
mark is defined here in about twenty lines, so changing the colour or the
glyph is a one-line edit and a re-run, not an image editor.

    python tools/make_icons.py

Writes extension/icons/icon{16,32,48,128}.png
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)

GLYPH = "ฮ"
BG_TOP = (139, 116, 255)
BG_BOTTOM = (99, 76, 214)
FG = (255, 255, 255)

# Leelawadee UI carries Thai; Tahoma is the fallback that has shipped with
# Windows for decades. Both render ฮ correctly.
FONT_CANDIDATES = (
    r"C:\Windows\Fonts\LeelawUI.ttf",
    r"C:\Windows\Fonts\leelawdb.ttf",
    r"C:\Windows\Fonts\tahomabd.ttf",
    r"C:\Windows\Fonts\tahoma.ttf",
)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("ไม่พบฟอนต์ไทยในเครื่อง — แก้ FONT_CANDIDATES ให้ชี้ไปที่ฟอนต์ที่มี")


def render(size: int) -> Image.Image:
    # Drawn at 8x and downsampled: the rounded corners and the glyph edges are
    # otherwise visibly jagged at 16px, where the icon is actually seen.
    scale = 8
    big = size * scale
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Vertical gradient, painted as one row per pixel of the upscaled square.
    for y in range(big):
        t = y / max(1, big - 1)
        draw.line(
            [(0, y), (big, y)],
            fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)),
        )

    # Mask the gradient into a rounded square.
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=255
    )
    img.putalpha(mask)

    font = load_font(int(big * 0.66))
    box = ImageDraw.Draw(img).textbbox((0, 0), GLYPH, font=font)
    ImageDraw.Draw(img).text(
        ((big - (box[2] - box[0])) / 2 - box[0], (big - (box[3] - box[1])) / 2 - box[1]),
        GLYPH,
        font=font,
        fill=FG,
    )
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        render(size).save(path)
        print(f"  {path.relative_to(OUT.parent.parent)}  ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
