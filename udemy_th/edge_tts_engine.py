"""Microsoft Edge neural synthesis with the same on-disk MP3 cache.

These are the same voices Windows exposes to the browser as "Niwat Online
(Natural)" and "Premwadee Online (Natural)" — Azure Neural, the same tier as
Google's Chirp 3 HD. The difference is where they are driven from.

Going through the browser's speechSynthesis means the audio exists only while
it is being spoken: it cannot be cached, cannot be prefetched, and cannot be
prepared in advance for a section queued for later. Driving the same voices
from here gives all three, and unlike Google it needs no account, no key and
has no monthly allowance to run out of.

The trade-off is honest: this is Edge's own endpoint rather than a documented
API, so it can change without notice. That is why it sits alongside the Google
engine instead of replacing it.
"""

from __future__ import annotations

import asyncio
import hashlib
import threading
from pathlib import Path

from .google_tts import TtsError

DEFAULT_VOICE = "th-TH-NiwatNeural"

# Everything Edge offers for Thai. Kept explicit so an unavailable voice fails
# here with a readable message rather than as a timeout inside the library.
VOICES = {
    "th-TH-NiwatNeural": "Niwat — ชาย",
    "th-TH-PremwadeeNeural": "Premwadee — หญิง",
}


class EdgeTts:
    name = "edge"
    label = "Microsoft Edge Neural (ฟรีไม่จำกัด)"
    voices = VOICES

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "audio"
        self._lock = threading.Lock()

    def status(self) -> dict:
        try:
            self._module()
        except TtsError as exc:
            return {"configured": False, "error": str(exc)}
        # No account, so no quota to report — the fields the UI reads are still
        # present, just unbounded.
        return {"configured": True, "voice": DEFAULT_VOICE, "unlimited": True}

    def synthesize(self, text: str, voice: str | None = DEFAULT_VOICE) -> dict:
        text = " ".join(text.split())
        voice = voice or DEFAULT_VOICE
        if not text:
            raise TtsError("ไม่มีข้อความไทยสำหรับสร้างเสียง")
        if voice not in VOICES:
            raise TtsError(f"ไม่รู้จักเสียง {voice} — เลือกได้: {', '.join(VOICES)}")

        digest = hashlib.sha256(f"{voice}\0{text}".encode("utf-8")).hexdigest()[:24]
        filename = f"{digest}.mp3"
        output = self.cache_dir / filename
        if output.exists() and output.stat().st_size:
            return {"file": filename, "cached": True}

        # Serialised for the same reason as the Google engine: two prefetches
        # racing on one cue would otherwise both synthesise and both write.
        with self._lock:
            if output.exists() and output.stat().st_size:
                return {"file": filename, "cached": True}

            edge_tts = self._module()
            try:
                audio = asyncio.run(_synthesize(edge_tts, text, voice))
            except TtsError:
                raise
            except Exception as exc:  # network, endpoint drift, throttling
                raise TtsError(f"Edge สร้างเสียงไม่สำเร็จ: {exc}") from exc

            if not audio:
                raise TtsError("Edge ส่งเสียงกลับมาว่างเปล่า")

            self.cache_dir.mkdir(parents=True, exist_ok=True)
            output.write_bytes(audio)
            return {"file": filename, "cached": False}

    @staticmethod
    def _module():
        try:
            import edge_tts
        except ImportError as exc:
            raise TtsError(
                "ยังไม่ได้ติดตั้ง edge-tts — รัน pip install -r requirements.txt"
            ) from exc
        return edge_tts


async def _synthesize(edge_tts, text: str, voice: str) -> bytes:
    """Collect the streamed audio chunks into one MP3."""
    chunks: list[bytes] = []
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)
