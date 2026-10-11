"""Meta SeamlessM4T — Thai speech on the local GPU.

Two ways to use it, chosen per request by `source_lang`:

* Thai text in, Thai speech out (source_lang "tha" or none): plain TTS of the
  subtitle the AI translator already produced. Most accurate — the translator
  knows the course context and keeps the glossary consistent.
* Original text in, Thai speech out (Text-to-Speech Translation, T2ST): the
  model translates and speaks in one step, so a line can be dubbed before the
  AI translation of it exists. Its own translation is literal — measured on a
  programming lesson it turned "string" into "เส้น" and "pod" into "กระบอก" —
  so the extension uses it as a fallback by default, not the main path.

The model is chosen with UDTH_SEAMLESS_MODEL: the medium v1 checkpoint by
default (1.2B params, ~2.5 GB VRAM in fp16), or a large / v2-large one. v2
checkpoints need their own model class, picked here from the id.
"""

from __future__ import annotations

import hashlib
import importlib.util
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

# ISO 639-1 (what YouTube and Udemy report) -> SeamlessM4T text language code.
# Every target is a language token of the processor's tokenizer (checked by
# tests/test_voices.py) — e.g. Malay is zlm there, and Sinhala is absent.
LANG_CODES = {
    "af": "afr", "ar": "arb", "az": "azj", "bg": "bul", "bn": "ben", "ca": "cat",
    "cs": "ces", "cy": "cym", "da": "dan", "de": "deu", "el": "ell", "en": "eng",
    "es": "spa", "et": "est", "eu": "eus", "fa": "pes", "fi": "fin", "fil": "tgl",
    "fr": "fra", "ga": "gle", "gl": "glg", "gu": "guj", "he": "heb", "iw": "heb",
    "hi": "hin", "hr": "hrv", "hu": "hun", "hy": "hye", "id": "ind", "is": "isl",
    "it": "ita", "ja": "jpn", "ka": "kat", "kk": "kaz", "km": "khm", "kn": "kan",
    "ko": "kor", "lo": "lao", "lt": "lit", "lv": "lvs", "ml": "mal", "mr": "mar",
    "ms": "zlm", "my": "mya", "nb": "nob", "ne": "npi", "nl": "nld", "no": "nob",
    "pa": "pan", "pl": "pol", "pt": "por", "ro": "ron", "ru": "rus",
    "sk": "slk", "sl": "slv", "sr": "srp", "sv": "swe", "sw": "swh", "ta": "tam",
    "te": "tel", "th": "tha", "tl": "tgl", "tr": "tur", "uk": "ukr", "ur": "urd",
    "uz": "uzn", "vi": "vie", "yue": "yue", "zh": "cmn",
}
# Chinese written in traditional characters has its own token.
TRADITIONAL_CHINESE = {"zh-hant", "zh-tw", "zh-hk", "zh-mo"}


def seamless_lang(code: str | None) -> str:
    """'en', 'en_US', 'pt-BR', 'zh-Hant', 'eng' -> Seamless code ('tha' if none).

    Raises TtsError for a language the model cannot read, rather than letting
    it guess and speak nonsense.
    """
    raw = (code or "").strip().lower().replace("_", "-")
    if not raw:
        return "tha"
    if raw in TRADITIONAL_CHINESE:
        return "cmn_Hant"
    if raw in LANG_CODES.values() or raw == "cmn_hant":
        return "cmn_Hant" if raw == "cmn_hant" else raw
    primary = raw.split("-")[0]
    if primary in LANG_CODES:
        return LANG_CODES[primary]
    raise TtsError(f"Seamless แปลจากภาษา {code!r} ไม่ได้")


class SeamlessTts:
    name = "seamless"
    label = "Meta SeamlessM4T (รันในเครื่อง / แปลเสียงเองได้)"
    voices = VOICES
    # Tells the extension this engine can take original-language text.
    translates = True

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "audio"
        self._processor = None
        self._model = None
        self._lock = threading.Lock()
        self._device = None

    def status(self) -> dict:
        # Answered on every /health, so it must be cheap: importing torch here
        # took ~10s on a fresh server, longer than the extension waits for
        # /health, and the popup reported the server as unreachable. Check the
        # packages are installed; the real import happens in warm()/synthesize.
        try:
            missing = [m for m in ("torch", "transformers") if importlib.util.find_spec(m) is None]
            if missing:
                raise ImportError(f"ยังไม่ได้ติดตั้ง {', '.join(missing)}")
            device_name = "GPU"
            if self._device:  # loaded: torch is imported already, asking is free
                import torch

                device_name = torch.cuda.get_device_name(0) if self._device.startswith("cuda") else "CPU"
            return {
                "configured": True,
                "ready": True,
                "error": "",
                "unlimited": True,
                "used": None,
                "limit": None,
                "device": device_name,
                "model": MODEL_ID,
            }
        except Exception as exc:
            return {"configured": False, "error": f"SeamlessM4T ยังไม่พร้อม: {exc}"}

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def warm(self) -> None:
        """Load the model now, so the first dubbed sentence does not wait."""
        with self._lock:
            self._ensure_loaded()

    def _ensure_loaded(self):
        if self._model is not None:
            return

        try:
            import torch
            import transformers
            from transformers import AutoProcessor

            # v2 checkpoints are a different architecture with their own class;
            # loading one into the v1 class fails.
            is_v2 = "v2" in MODEL_ID.lower()
            model_class = transformers.SeamlessM4Tv2Model if is_v2 else transformers.SeamlessM4TModel

            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if torch.cuda.is_available() else torch.float32

            print(f"[SeamlessM4T] กำลังโหลดโมเดล {MODEL_ID} ลงบน {device} ({dtype})...", flush=True)
            self._processor = AutoProcessor.from_pretrained(MODEL_ID)
            self._model = model_class.from_pretrained(MODEL_ID, torch_dtype=dtype).to(device)
            self._device = device
            print(f"[SeamlessM4T] โหลดโมเดลเรียบร้อย พร้อมใช้งานบน {device}", flush=True)
        except Exception as exc:
            raise TtsError(f"โหลดโมเดล Meta SeamlessM4T ไม่สำเร็จ ({MODEL_ID}): {exc}") from exc

    @staticmethod
    def cache_key(text: str, src: str) -> str:
        # Thai keeps the key it always had, so audio cached before T2ST existed
        # is still found.
        seed = f"seamless:{MODEL_ID}:{text}" if src == "tha" else f"seamless:{MODEL_ID}:{src}>tha:{text}"
        return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]

    def synthesize(self, text: str, voice: str | None = None, source_lang: str | None = None) -> dict:
        text = " ".join((text or "").split())
        if not text:
            raise TtsError("ข้อความว่างเปล่า")
        src = seamless_lang(source_lang)

        cache_key = self.cache_key(text, src)
        out_path = self.cache_dir / f"{cache_key}.wav"
        # When translating, the Thai the model said is kept beside the audio:
        # the extension shows it as a provisional subtitle until the AI
        # translation of that line arrives.
        text_path = out_path.with_suffix(".txt")

        def cached() -> dict | None:
            if not out_path.is_file():
                return None
            result = {"file": out_path.name, "cached": True}
            if src != "tha" and text_path.is_file():
                result["text"] = text_path.read_text(encoding="utf-8")
            return result

        hit = cached()
        if hit:
            return hit

        with self._lock:
            hit = cached()
            if hit:
                return hit

            self._ensure_loaded()
            import soundfile as sf
            import torch

            try:
                inputs = self._processor(text=text, src_lang=src, return_tensors="pt").to(self._device)
                with torch.no_grad():
                    # One pass yields both the speech and the Thai text it
                    # spoke (the intermediate text-to-text output).
                    output = self._model.generate(
                        **inputs, tgt_lang="tha", generate_speech=True, return_intermediate_token_ids=True
                    )
                audio_np = output.waveform[0].cpu().squeeze().to(torch.float32).numpy()
                spoken = ""
                if src != "tha" and output.sequences is not None:
                    spoken = self._processor.decode(output.sequences[0].tolist(), skip_special_tokens=True).strip()

                wav_io = io.BytesIO()
                sf.write(wav_io, audio_np, samplerate=SAMPLE_RATE, format="WAV")
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                # Written under a temporary name first: a half-written file
                # would otherwise look like a valid cache hit forever after.
                partial = out_path.with_name(out_path.name + ".part")
                if spoken:
                    text_path.write_text(spoken, encoding="utf-8")
                partial.write_bytes(wav_io.getvalue())
                partial.replace(out_path)
                result = {"file": out_path.name, "cached": False}
                if spoken:
                    result["text"] = spoken
                return result
            except Exception as exc:
                raise TtsError(f"Meta Seamless สังเคราะห์เสียงไม่สำเร็จ: {exc}") from exc
