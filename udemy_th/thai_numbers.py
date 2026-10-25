"""Write numbers out as Thai words before a voice reads them.

Every Thai voice measured on the A100 misread bare digits (tests on 16
lecture-style sentences, read back by Thai Whisper): "2025" came out as
"2005", "25" or nonsense, "0" as "โล่ง", "1" as "อีก". Spelled out, the same
voices read them correctly, so the text is fixed before it reaches any of them.

Only standalone numbers are touched. Digits that belong to a name or code
(h1, ES6, v2.0, index2.html, 192.168.0.1) are left exactly as they are.
"""

from __future__ import annotations

import re

_DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"]
_PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"]

# A number on its own: not glued to a Latin letter, a digit, a dot-name or a
# path on either side. Thai letters do not count (Thai is written without
# spaces: "บทที่12" is a number). Thousands separators and one decimal part
# are allowed, and a trailing % is read as เปอร์เซ็นต์.
_NUMBER = re.compile(
    r"(?<![A-Za-z0-9_.\-/:@#])"
    r"(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%?)"
    r"(?![A-Za-z0-9_/:@#]|\.[A-Za-z0-9_])"
)


def _below_million(n: int) -> str:
    """0 < n < 1,000,000"""
    words = []
    digits = str(n)
    size = len(digits)
    for position, char in enumerate(digits):
        d = int(char)
        place = size - position - 1
        if d == 0:
            continue
        if place == 1 and d == 1:
            words.append("สิบ")
        elif place == 1 and d == 2:
            words.append("ยี่สิบ")
        elif place == 0 and d == 1 and size > 1:
            words.append("เอ็ด")
        else:
            words.append(_DIGITS[d] + _PLACES[place])
    return "".join(words)


def number_words(n: int) -> str:
    """12 -> สิบสอง, 2025 -> สองพันยี่สิบห้า, 1000000 -> หนึ่งล้าน"""
    if n == 0:
        return _DIGITS[0]
    parts = []
    millions, rest = divmod(n, 1_000_000)
    if millions:
        parts.append(number_words(millions) + "ล้าน")
    if rest:
        parts.append(_below_million(rest))
    return "".join(parts)


def _spell(match: re.Match) -> str:
    whole, fraction, percent = match.group(1), match.group(2), match.group(3)
    words = number_words(int(whole.replace(",", "")))
    if fraction:
        words += "จุด" + "".join(_DIGITS[int(d)] for d in fraction)
    if percent:
        words += "เปอร์เซ็นต์"
    return words


def spell_numbers(text: str) -> str:
    """Thai sentence with its standalone numbers written as words."""
    return _NUMBER.sub(_spell, text)
