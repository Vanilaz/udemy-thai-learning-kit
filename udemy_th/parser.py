"""Turn whatever you pasted out of Udemy into a clean list of Segments.

Four input shapes are supported, auto-detected in this order:

1. SRT       — downloaded/exported caption file
2. WebVTT    — same, .vtt
3. Udemy transcript panel — what you get by selecting the transcript sidebar
                            and pressing Ctrl+C. Timestamps sit on their own
                            line (or lead the text line) as M:SS / H:MM:SS.
4. Plain text — no timing at all; split into sentence-sized chunks.
"""

from __future__ import annotations

import re

from .models import Segment

# 00:01:02,500  or  00:01:02.500
_SRT_TIME = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)
# A bare timestamp on its own line, optionally followed by text: "1:23" / "01:02:03  hello"
_PANEL_TIME = re.compile(r"^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*(.*)$")
# Trailing sentence punctuation, used when splitting untimed prose.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z\"'(\[])")

# When a transcript has no end time for its final line, assume this duration.
_TAIL_SECONDS = 4.0
# Untimed text is packed into pseudo-segments of roughly this many characters.
_PLAIN_CHUNK_CHARS = 220


def parse(raw: str) -> list[Segment]:
    """Detect the format of `raw` and return numbered segments."""
    text = raw.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        return []

    if _SRT_TIME.search(text):
        return _renumber(_parse_timed_blocks(text))
    if text.lstrip().upper().startswith("WEBVTT"):
        return _renumber(_parse_timed_blocks(text))

    lines = [ln for ln in text.split("\n") if ln.strip()]
    timestamped = sum(1 for ln in lines if _PANEL_TIME.match(ln))
    # The panel format alternates time/text, so even half the lines matching is
    # a strong signal. Prose rarely has lines that look like "1:23".
    if lines and timestamped / len(lines) >= 0.25:
        return _renumber(_parse_panel(lines))

    return _renumber(_parse_plain(text))


def _parse_timed_blocks(text: str) -> list[Segment]:
    """Parse SRT and WebVTT — both are 'cue header, then text lines'."""
    segments: list[Segment] = []
    for block in re.split(r"\n{2,}", text):
        match = _SRT_TIME.search(block)
        if not match:
            continue
        g = [int(x) for x in match.groups()]
        start = g[0] * 3600 + g[1] * 60 + g[2] + _ms(match.group(4))
        end = g[4] * 3600 + g[5] * 60 + g[6] + _ms(match.group(8))

        # Everything after the cue header line is caption text.
        body_lines = block[match.end():].split("\n")[1:]
        body = " ".join(ln.strip() for ln in body_lines if ln.strip())
        body = _strip_markup(body)
        if body:
            segments.append(Segment(id=0, text=body, start=start, end=end))
    return segments


def _parse_panel(lines: list[str]) -> list[Segment]:
    """Parse the copied Udemy transcript sidebar.

    Timestamps mark only the *start* of each line, so each segment ends where
    the next one begins.
    """
    starts: list[float] = []
    texts: list[str] = []
    pending: list[str] = []

    def flush() -> None:
        if pending and texts:
            texts[-1] = (texts[-1] + " " + " ".join(pending)).strip()
        pending.clear()

    for line in lines:
        match = _PANEL_TIME.match(line)
        if match:
            flush()
            hours, minutes, seconds, trailing = match.groups()
            starts.append(
                (int(hours) if hours else 0) * 3600 + int(minutes) * 60 + int(seconds)
            )
            texts.append(trailing.strip())
        elif texts:
            pending.append(line.strip())
        # Text before the first timestamp is a panel header — drop it.
    flush()

    segments: list[Segment] = []
    for i, (start, body) in enumerate(zip(starts, texts)):
        if not body:
            continue
        end = starts[i + 1] if i + 1 < len(starts) else start + _TAIL_SECONDS
        segments.append(Segment(id=0, text=body, start=float(start), end=float(end)))
    return segments


def _parse_plain(text: str) -> list[Segment]:
    """No timing available — pack sentences into readable chunks."""
    sentences = [s.strip() for s in _SENTENCE_SPLIT.split(" ".join(text.split())) if s.strip()]
    segments: list[Segment] = []
    buffer = ""
    for sentence in sentences:
        candidate = f"{buffer} {sentence}".strip()
        if buffer and len(candidate) > _PLAIN_CHUNK_CHARS:
            segments.append(Segment(id=0, text=buffer))
            buffer = sentence
        else:
            buffer = candidate
    if buffer:
        segments.append(Segment(id=0, text=buffer))
    return segments


def _ms(raw: str) -> float:
    """'5' -> 0.5s, '50' -> 0.5s, '500' -> 0.5s (SRT and VTT both occur)."""
    return int(raw) / (10 ** len(raw))


def _strip_markup(text: str) -> str:
    """Remove VTT cue tags like <v Speaker> and <00:00:01.000>."""
    return re.sub(r"<[^>]*>", "", text).strip()


def _renumber(segments: list[Segment]) -> list[Segment]:
    for i, segment in enumerate(segments, start=1):
        segment.id = i
    return segments
