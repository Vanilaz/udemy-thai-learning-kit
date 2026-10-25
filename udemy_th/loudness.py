"""Even out how loud each dubbed line is.

The voice models make every line from scratch and none of them normalise it:
measured over 80 OmniVoice / F5 clips from one lecture, the speech in one line
was up to 14.6 dB louder than in another (8.3 dB between the 10th and 90th
percentile), so the dub kept getting louder and quieter from line to line.

`normalize_wav` brings the speech in a 16-bit PCM WAV to one level. Only the
parts that are speech count towards that level, so a line with long pauses is
not turned up too far. A gentle limiter keeps the peaks of a quiet line that
had to be turned up from clipping. Anything else (MP3, other sample formats,
a file that does not parse) comes back unchanged.

Standard library only: this runs for every clip the player fetches.
"""

from __future__ import annotations

import io
import math
import sys
import wave
from array import array

TARGET_DBFS = -20.0  # speech level every line is brought to
SPEECH_GATE_DBFS = -45.0  # quieter 50 ms frames are pauses, not speech
MAX_BOOST_DB = 18.0
MAX_CUT_DB = 12.0
LIMIT_START = 0.7  # of full scale; above this, peaks are bent down smoothly
FRAME_SECONDS = 0.05
FULL_SCALE = 32768.0


def _db(ratio: float) -> float:
    return 20.0 * math.log10(ratio) if ratio > 0 else -120.0


def speech_level(samples: array, rate: int, channels: int = 1) -> float | None:
    """RMS level in dBFS over the speech frames, or None when there is none."""
    step = max(1, int(rate * FRAME_SECONDS)) * channels
    gate = (FULL_SCALE * 10 ** (SPEECH_GATE_DBFS / 20.0)) ** 2
    total = 0.0
    count = 0
    for start in range(0, len(samples), step):
        frame = samples[start : start + step]
        if not frame:
            break
        energy = sum(x * x for x in frame)
        if energy / len(frame) >= gate:
            total += energy
            count += len(frame)
    if not count:
        return None
    return _db(math.sqrt(total / count) / FULL_SCALE)


def _limit(x: float) -> float:
    """Unity below LIMIT_START, then a smooth curve that never reaches 1."""
    sign = -1.0 if x < 0 else 1.0
    a = abs(x)
    if a <= LIMIT_START:
        return x
    room = 1.0 - LIMIT_START
    return sign * (LIMIT_START + room * math.tanh((a - LIMIT_START) / room))


def gain_db(level: float) -> float:
    return max(-MAX_CUT_DB, min(MAX_BOOST_DB, TARGET_DBFS - level))


def normalize_wav(data: bytes) -> bytes:
    try:
        with wave.open(io.BytesIO(data)) as reader:
            params = reader.getparams()
            frames = reader.readframes(params.nframes)
    except (wave.Error, EOFError, ValueError):
        return data
    if params.sampwidth != 2 or not frames:
        return data
    samples = array("h")
    samples.frombytes(frames[: len(frames) - len(frames) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    level = speech_level(samples, params.framerate, params.nchannels)
    if level is None:
        return data
    gain = gain_db(level)
    if abs(gain) < 0.5:
        return data
    factor = 10 ** (gain / 20.0)
    out = array(
        "h",
        (max(-32768, min(32767, round(_limit(x * factor / FULL_SCALE) * FULL_SCALE))) for x in samples),
    )
    if sys.byteorder == "big":
        out.byteswap()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setparams(params)
        writer.writeframes(out.tobytes())
    return buffer.getvalue()
