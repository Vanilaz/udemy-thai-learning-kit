"""Generate the extension's icon set.

Kept as a script rather than as checked-in binaries nobody can edit: the mark
is defined here, so changing a colour or a proportion is an edit and a re-run.

    python tools/make_icons.py

Writes extension/icons/icon{16,32,48,128}.png

The mark is the same teal tile with a dark "ท" used inside the extension (the
menu logo, the loading card, the popup), so the toolbar and the player read as
one product. At 48px and up two subtitle bars sit under the letter: Thai, then
the original fainter, which is what the extension puts on a video. At 16 and
32px those bars would be a smudge, so the small sizes carry the letter alone.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
SIZES = (16, 32, 48, 128)
DETAILED_FROM = 48  # sizes at or above this get the subtitle bars

GLYPH = "ท"
TEAL_LIGHT = (110, 240, 218)
TEAL = (45, 212, 191)
TEAL_DARK = (15, 163, 148)
INK = (4, 47, 43)  # the dark text colour used on teal everywhere in the UI

# Leelawadee UI carries Thai and ships with Windows; Tahoma is the fallback.
FONT_CANDIDATES = (
    r"C:\Windows\Fonts\LeelaUIb.ttf",
    r"C:\Windows\Fonts\leelawdb.ttf",
    r"C:\Windows\Fonts\LeelawUI.ttf",
    r"C:\Windows\Fonts\tahomabd.ttf",
    r"C:\Windows\Fonts\tahoma.ttf",
)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit("ไม่พบฟอนต์ไทยในเครื่อง แก้ FONT_CANDIDATES ให้ชี้ไปที่ฟอนต์ที่มี")


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def tile(big: int) -> Image.Image:
    """Diagonal three-stop teal gradient in a rounded square, with a soft top sheen."""
    img = Image.new("RGBA", (big, big))
    px = img.load()
    for y in range(big):
        for x in range(big):
            t = (x + y) / (2 * (big - 1))
            colour = lerp(TEAL_LIGHT, TEAL, t / 0.55) if t < 0.55 else lerp(TEAL, TEAL_DARK, (t - 0.55) / 0.45)
            # Sheen: white fading out over the top half.
            sheen = max(0.0, 0.35 * (1 - y / (big * 0.5)))
            px[x, y] = (*lerp(colour, (255, 255, 255), sheen), 255)
    inset = round(big * 4 / 128)
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [inset, inset, big - 1 - inset, big - 1 - inset], radius=round(big * 30 / 128), fill=255
    )
    img.putalpha(mask)
    return img


def render(size: int) -> Image.Image:
    # Drawn at 8x and downsampled: the corners and the glyph are otherwise
    # visibly jagged at 16px, where the icon is actually seen.
    big = size * 8
    unit = big / 128  # design units: everything below is in a 128 grid
    img = tile(big)
    draw = ImageDraw.Draw(img)
    detailed = size >= DETAILED_FROM

    font = load_font(round((68 if detailed else 84) * unit))
    box = draw.textbbox((0, 0), GLYPH, font=font)
    glyph_w, glyph_h = box[2] - box[0], box[3] - box[1]
    centre_y = (52 if detailed else 64) * unit
    draw.text((big / 2 - glyph_w / 2 - box[0], centre_y - glyph_h / 2 - box[1]), GLYPH, font=font, fill=INK)

    if detailed:
        draw.rounded_rectangle([26 * unit, 88 * unit, 102 * unit, 99 * unit], radius=5.5 * unit, fill=INK)
        # The original, under the Thai: same ink at 45% over the tile.
        faint = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        ImageDraw.Draw(faint).rounded_rectangle(
            [40 * unit, 104 * unit, 88 * unit, 112 * unit], radius=4 * unit, fill=(*INK, 115)
        )
        img = Image.alpha_composite(img, faint)
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = OUT / f"icon{size}.png"
        render(size).save(path, optimize=True)
        print(f"  {path.relative_to(OUT.parent.parent)}  ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
