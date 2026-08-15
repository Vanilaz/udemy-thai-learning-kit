"""Write .srt subtitle files from translated segments."""

from __future__ import annotations

from .models import Segment

# Fallback pacing when the source transcript carried no timestamps at all.
_WORDS_PER_SECOND = 2.6
_MIN_DURATION = 1.4


def to_srt(segments: list[Segment], mode: str = "dual") -> str:
    """Render segments as SRT text.

    mode:
      "thai" — Thai only
      "dual" — English on top, Thai underneath (recommended while learning:
               you can catch it when the machine transcript misheard a term)
      "en"   — original only
    """
    timed = _ensure_timing(segments)
    blocks: list[str] = []
    for i, segment in enumerate(timed, start=1):
        body = _body(segment, mode)
        if not body:
            continue
        blocks.append(
            f"{i}\n{_ts(segment.start)} --> {_ts(segment.end)}\n{body}\n"
        )
    return "\n".join(blocks)


def _body(segment: Segment, mode: str) -> str:
    thai = (segment.thai or "").strip()
    english = segment.text.strip()
    if mode == "thai":
        return thai or english
    if mode == "en":
        return english
    if thai and thai != english:
        return f"{english}\n{thai}"
    return english


def _ensure_timing(segments: list[Segment]) -> list[Segment]:
    """Give untimed segments an estimated duration so the file is still valid.

    Only used for plain-text input — real transcripts keep their own timing.
    """
    if all(s.has_timing for s in segments):
        return segments

    cursor = 0.0
    timed: list[Segment] = []
    for segment in segments:
        if segment.has_timing:
            timed.append(segment)
            cursor = segment.end
            continue
        duration = max(_MIN_DURATION, len(segment.text.split()) / _WORDS_PER_SECOND)
        timed.append(
            Segment(
                id=segment.id,
                text=segment.text,
                thai=segment.thai,
                start=cursor,
                end=cursor + duration,
            )
        )
        cursor += duration
    return timed


def _ts(seconds: float) -> str:
    if seconds is None:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, ms = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"
