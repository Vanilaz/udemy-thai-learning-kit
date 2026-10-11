"""Meta SeamlessM4T v2 synthesis engine.

Speech/Text-to-Speech using Meta's flagship seamless-m4t-v2-large / seamless-m4t-medium.
This produces the exact voice style popularized in Facebook Reel / Meta Auto-Dubbing.
"""

from __future__ import annotations

import hashlib
import io
import os
import threading
from pathlib import Path

from .google_tts import TtsError

MODEL_ID = os.environ.get("UDTH_SEAMLESS_MODEL", "facebook/hf-seamless-m4t-medium")
SAMPLE_RATE = 16000

VOICES = {
    "seamless:th": "Meta Seamless (เสียงไทยธรรมชาติ / Reels)",
}


class SeamlessTts:
    name = "seamless"
    label = "Meta SeamlessM4T v2 (โมเดลพากย์เสียงของ Meta)"
    voices = VOICES

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "audio"
        self._processor = None
        self._model = None
        self._lock = threading.Lock()
        self._device = None

    def status(self) -> dict:
        try:
            import torch
            has_cuda = torch.cuda.is_available()
            device_name = torch.cuda.get_device_name(0) if has_cuda else "CPU"
            return {
                "configured": True,
                "name": self.name,
                "label": self.label,
                "ready": True,
                "error": "",
                "unlimited": True,
                "used": None,
                "limit": None,
                "device": device_name,
                "model": MODEL_ID,
                "voices": [
                    {"id": k, "label": f"{v} [{device_name}]"}
                    for k, v in self.voices.items()
                ],
            }
        except Exception as exc:
            return {
                "configured": False,
                "name": self.name,
                "label": self.label,
                "ready": False,
                "error": f"SeamlessM4T ยังไม่พร้อม: {exc}",
                "voices": [],
            }

    def _ensure_loaded(self):
        if self._model is not None:
            return

        try:
            import torch
            from transformers import AutoProcessor, SeamlessM4TModel

            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if torch.cuda.is_available() else torch.float32

            print(f"[SeamlessM4T] กำลังโหลดโมเดล {MODEL_ID} ลงบน {device} ({dtype})...")
            self._processor = AutoProcessor.from_pretrained(MODEL_ID)
            self._model = SeamlessM4TModel.from_pretrained(
                MODEL_ID,
                torch_dtype=dtype,
            ).to(device)
            self._device = device
            print(f"[SeamlessM4T] โหลดโมเดลเรียบร้อย พร้อมใช้งานบน {device}")
        except Exception as exc:
            raise TtsError(
                f"โหลดโมเดล Meta SeamlessM4T ไม่สำเร็จ ({MODEL_ID}): {exc}"
            ) from exc

    def synthesize(self, text: str, voice: str | None = None) -> dict:
        text = (text or "").strip()
        if not text:
            raise TtsError("ข้อความว่างเปล่า")

        cache_key = hashlib.sha256(
            f"seamless:{MODEL_ID}:{text}".encode("utf-8")
        ).hexdigest()[:24]
        out_path = self.cache_dir / f"{cache_key}.mp3"

        if out_path.is_file():
            return {"file": out_path.name, "cached": True}

        with self._lock:
            if out_path.is_file():
                return {"file": out_path.name, "cached": True}

            self._ensure_loaded()
            import soundfile as sf
            import torch

            try:
                # Text-to-Speech synthesize to Thai (tgt_lang="tha")
                inputs = self._processor(
                    text=text, src_lang="tha", return_tensors="pt"
                ).to(self._device)

                with torch.no_grad():
                    output = self._model.generate(
                        **inputs,
                        tgt_lang="tha",
                        generate_speech=True,
                    )

                audio_tensor = output[0].cpu().squeeze().to(torch.float32)
                audio_np = audio_tensor.numpy()

                # Save directly as wav/mp3 using soundfile
                wav_io = io.BytesIO()
                sf.write(wav_io, audio_np, samplerate=SAMPLE_RATE, format="WAV")
                wav_bytes = wav_io.getvalue()

                # Convert to mp3 or write as wav
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                # Since soundfile writes wav easily, we can write directly to cache
                wav_path = self.cache_dir / f"{cache_key}.wav"
                wav_path.write_bytes(wav_bytes)

                return {"file": wav_path.name, "cached": False}
            except Exception as exc:
                raise TtsError(f"Meta Seamless สังเคราะห์เสียงไม่สำเร็จ: {exc}") from exc
