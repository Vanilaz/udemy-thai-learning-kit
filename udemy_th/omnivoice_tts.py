"""OmniVoice Thai — local GPU synthesis, no account and no quota.

A 0.6B diffusion-LM fine-tuned for Thai (hotdogs/omnivoice-thai, Apache-2.0).
Reported RTF is 0.025, so an hour-long lecture is a few seconds of GPU work;
weights are small enough for any card with ~4GB free.

Two things it can do that no hosted engine here can:

  * run entirely offline, so a long course costs nothing and leaks nothing
  * clone a voice from a reference clip — point UDTH_OMNIVOICE_REF at a short
    sample of the instructor and the dub keeps their voice instead of swapping
    in a stranger's

The model is loaded on first use, not at import: the server must start in a
second on a machine with no GPU and no torch installed, and most users will
never select this engine.
"""

from __future__ import annotations

import hashlib
import os
import threading
from pathlib import Path

from .google_tts import TtsError

MODEL_ID = os.environ.get("UDTH_OMNIVOICE_MODEL", "hotdogs/omnivoice-thai")
SAMPLE_RATE = 24000

# The model designs a voice from a plain-language description rather than
# selecting a preset, so these are prompts, not voice ids.
VOICES = {
    "omnivoice:male": "ชาย (เสียงทุ้ม)",
    "omnivoice:female": "หญิง",
    "omnivoice:male-bright": "ชาย (เสียงสดใส)",
    "omnivoice:female-calm": "หญิง (เสียงนุ่ม)",
    "omnivoice:clone": "โคลนเสียงจากไฟล์ตัวอย่าง",
}

_INSTRUCTIONS = {
    "omnivoice:male": "male, low pitch",
    "omnivoice:female": "female",
    "omnivoice:male-bright": "male, bright, energetic",
    "omnivoice:female-calm": "female, calm, low pitch",
}


class OmniVoiceTts:
    name = "omnivoice"
    label = "OmniVoice Thai (รันในเครื่อง / ต้องมี GPU)"
    voices = VOICES

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "audio"
        self.reference = os.environ.get("UDTH_OMNIVOICE_REF") or None
        self._model = None
        # Serialises both the one-time load and every generate() call: the
        # model is not thread-safe and two concurrent prefetches would other-
        # wise both try to load it onto the GPU.
        self._lock = threading.Lock()

    def status(self) -> dict:
        try:
            self._imports()
        except TtsError as exc:
            return {"configured": False, "error": str(exc)}
        return {
            "configured": True,
            "voice": "omnivoice:male",
            "unlimited": True,
            "loaded": self._model is not None,
            "cloning": bool(self.reference),
        }

    def synthesize(self, text: str, voice: str | None = None) -> dict:
        text = " ".join(text.split())
        voice = voice or "omnivoice:male"
        if not text:
            raise TtsError("ไม่มีข้อความไทยสำหรับสร้างเสียง")
        if voice not in VOICES:
            raise TtsError(f"ไม่รู้จักเสียง {voice} — เลือกได้: {', '.join(VOICES)}")
        if voice == "omnivoice:clone" and not self.reference:
            raise TtsError(
                "ยังไม่ได้ตั้งไฟล์เสียงตัวอย่าง — ตั้ง UDTH_OMNIVOICE_REF "
                "ให้ชี้ไปที่ไฟล์เสียง 5-10 วินาทีก่อน"
            )

        # The reference clip is part of the identity of the output, so changing
        # it must not return the previous voice from the cache.
        seed = f"{voice}\0{self.reference or ''}\0{text}"
        digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
        # WAV, not MP3: encoding to MP3 would need an extra dependency, and the
        # file never leaves this machine so the size does not matter.
        filename = f"{digest}.wav"
        output = self.cache_dir / filename
        if output.exists() and output.stat().st_size:
            return {"file": filename, "cached": True}

        with self._lock:
            if output.exists() and output.stat().st_size:
                return {"file": filename, "cached": True}

            model = self._load()
            try:
                kwargs = {"text": text}
                if voice == "omnivoice:clone":
                    kwargs["reference_audio"] = self.reference
                else:
                    kwargs["instruct"] = _INSTRUCTIONS[voice]
                audio = model.generate(**kwargs)
            except Exception as exc:  # OOM, bad reference clip, model drift
                raise TtsError(f"OmniVoice สร้างเสียงไม่สำเร็จ: {exc}") from exc

            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._write_wav(audio, output)
            return {"file": filename, "cached": False}

    def _load(self):
        if self._model is not None:
            return self._model
        omnivoice, _, _ = self._imports()
        print(f"  กำลังโหลดโมเดล OmniVoice ({MODEL_ID}) ครั้งแรก ...", flush=True)
        try:
            self._model = omnivoice.OmniVoice.from_pretrained(MODEL_ID)
        except Exception as exc:
            raise TtsError(f"โหลดโมเดล OmniVoice ไม่สำเร็จ: {exc}") from exc
        print("  โหลดโมเดลเสร็จแล้ว", flush=True)
        return self._model

    def _write_wav(self, audio, output: Path) -> None:
        _, sf, np = self._imports()
        samples = np.asarray(audio)
        # generate() returns a batch; take the first clip.
        if samples.ndim > 1:
            samples = samples[0]
        # Written to a temporary name first: a half-written file left behind by
        # a crash would otherwise look like a valid cache hit forever after.
        partial = output.with_name(output.name + ".part")
        sf.write(str(partial), samples, SAMPLE_RATE)
        partial.replace(output)

    @staticmethod
    def _imports():
        try:
            import omnivoice
        except ImportError as exc:
            raise TtsError(
                "ยังไม่ได้ติดตั้ง OmniVoice — รัน pip install omnivoice soundfile"
            ) from exc
        try:
            import numpy as np
            import soundfile as sf
        except ImportError as exc:
            raise TtsError("ยังไม่ได้ติดตั้ง soundfile/numpy — รัน pip install soundfile") from exc
        return omnivoice, sf, np
