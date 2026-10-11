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
import importlib.util
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
    "omnivoice:male-bright": "ชาย (วัยหนุ่ม เสียงกลาง)",
    "omnivoice:female-calm": "หญิง (เสียงทุ้ม นุ่ม)",
    "omnivoice:clone": "โคลนเสียงจากไฟล์ตัวอย่าง",
}

# Only the model's fixed vocabulary is accepted — anything else (e.g. "bright",
# "calm") is rejected for every sentence. Allowed: male/female; child,
# teenager, young adult, middle-aged, elderly; very low … very high pitch;
# whisper; "<x> accent". Ids are kept stable so saved settings still work.
_INSTRUCTIONS = {
    "omnivoice:male": "male, low pitch",
    "omnivoice:female": "female",
    "omnivoice:male-bright": "male, young adult, moderate pitch",
    "omnivoice:female-calm": "female, middle-aged, low pitch",
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
        # Cheap on purpose — see SeamlessTts.status: importing omnivoice (and
        # torch with it) on every /health made a fresh server look unreachable.
        missing = [m for m in ("omnivoice", "soundfile", "numpy") if importlib.util.find_spec(m) is None]
        if missing:
            return {
                "configured": False,
                "error": f"ยังไม่ได้ติดตั้ง {', '.join(missing)} — รัน install.cmd --gpu",
                "voices": [],
            }
        return {
            "configured": True,
            "ready": True,
            "error": "",
            "unlimited": True,
            "used": None,
            "limit": None,
            "voices": [
                {"id": k, "label": v}
                for k, v in VOICES.items()
            ],
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

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def warm(self) -> None:
        """Load the model now, so the first dubbed sentence does not wait ~1min."""
        with self._lock:
            self._load()

    def _load(self):
        if self._model is not None:
            return self._model
        omnivoice, _, _ = self._imports()
        print(f"  กำลังโหลดโมเดล OmniVoice ({MODEL_ID}) ครั้งแรก ...", flush=True)
        try:
            import torch
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            self._model = omnivoice.OmniVoice.from_pretrained(MODEL_ID).to(device)
            if hasattr(self._model, "audio_tokenizer") and self._model.audio_tokenizer is not None:
                self._model.audio_tokenizer = self._model.audio_tokenizer.to(device)
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
        partial = output.with_name(output.name + ".part.wav")
        try:
            sf.write(str(partial), samples, SAMPLE_RATE, format="WAV")
            partial.replace(output)
        finally:
            if partial.is_file():
                try:
                    partial.unlink()
                except OSError:
                    pass

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
