"""Thai Flow-Matching (F5-TTS) voice engines: ThonburianTTS megaF5 and OpenJaiTTS v1.

Both are Thai fine-tunes of F5-TTS run through the `flowtts` pipeline
(biodatlab/thonburian-tts) with a Vocos vocoder, and both clone a voice from a
5-10s sample (`UDTH_VOICE_REF` or `UDTH_OMNIVOICE_REF`). Their weights are
licensed for non-commercial use only (ThonburianTTS CC BY-NC-SA 4.0,
OpenJaiTTS CC BY-NC 4.0).

Because F5-TTS flow matching is compute-intensive, these engines are designed to
run primarily on the Colab A100 Voice Server (`UDTH_A100_URL`), while also
supporting local CUDA execution when `thonburian-tts` (`flowtts`) is installed.
"""

from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import os
import sys
import threading
import types
from pathlib import Path

from . import a100_voice
from .google_tts import TtsError

SAMPLE_RATE = 24000
DEFAULT_REF_TEXT = "สวัสดีครับ วันนี้เราจะมาเรียนรู้การสร้างเว็บไซต์ด้วยภาษา HTML และ CSS กันนะครับ"

THONBURIAN_VOICES = {
    "thonburian:default": "เสียงมาตรฐาน",
    "thonburian:clone": "โคลนเสียงจากไฟล์ตัวอย่าง",
}

OPENJAI_VOICES = {
    "openjai:default": "เสียงมาตรฐาน",
    "openjai:clone": "โคลนเสียงจากไฟล์ตัวอย่าง",
}


def _module_available(name: str) -> bool:
    """True if `name` can be imported. Never raises.

    `importlib.util.find_spec` raises ValueError when the module is already in
    `sys.modules` with `__spec__ = None` (e.g. a stub), so check `sys.modules`
    first and guard the lookup.
    """
    if name in sys.modules:
        return True
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _make_stub(name: str, **attrs) -> types.ModuleType:
    """Placeholder module with a real ModuleSpec so later find_spec calls
    (ours or third-party, e.g. transformers' availability probes) don't raise."""
    mod = types.ModuleType(name)
    mod.__spec__ = importlib.machinery.ModuleSpec(name, loader=None)
    for key, value in attrs.items():
        setattr(mod, key, value)
    return mod


def _install_stub(name: str, **attrs) -> bool:
    """Register a stub for `name` only if the real package is absent. Returns True if installed."""
    if _module_available(name):
        return False
    sys.modules[name] = _make_stub(name, **attrs)
    return True


class _FlowTtsBase:
    name: str = ""
    label: str = ""
    voices: dict[str, str] = {}
    checkpoint: str = ""
    vocab: str = ""
    default_voice: str = ""

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "audio"
        self.reference = os.environ.get("UDTH_VOICE_REF") or os.environ.get("UDTH_OMNIVOICE_REF") or None
        self.reference_text = (
            os.environ.get("UDTH_VOICE_REF_TEXT") or os.environ.get("UDTH_OMNIVOICE_REF_TEXT") or None
        )
        self._pipe = None
        self._lock = threading.Lock()

    def _ref_path(self) -> Path | None:
        raw = self.reference or os.environ.get("UDTH_VOICE_REF") or os.environ.get("UDTH_OMNIVOICE_REF")
        return Path(raw) if raw else None

    def _ref_text(self) -> str | None:
        return self.reference_text or os.environ.get("UDTH_VOICE_REF_TEXT") or os.environ.get("UDTH_OMNIVOICE_REF_TEXT")

    def status(self) -> dict:
        ref = self._ref_path()
        cloning = bool(ref) and ref.is_file()
        if a100_voice.configured():
            return {
                "configured": True,
                "ready": True,
                "error": "",
                "unlimited": True,
                "used": None,
                "limit": None,
                "voices": [{"id": k, "label": v} for k, v in self.voices.items()],
                "loaded": True,
                "cloning": cloning,
                "remote": a100_voice.base_url(),
            }
        missing = [m for m in ("flowtts", "soundfile", "numpy") if not _module_available(m)]
        if missing:
            return {
                "configured": False,
                "error": (
                    f"ต้องต่อ A100 (ตั้ง UDTH_A100_URL ใน .env) หรือติดตั้ง {', '.join(missing)} ในเครื่อง"
                ),
                "voices": [],
            }
        return {
            "configured": True,
            "ready": True,
            "error": "",
            "unlimited": True,
            "used": None,
            "limit": None,
            "voices": [{"id": k, "label": v} for k, v in self.voices.items()],
            "loaded": self._pipe is not None,
            "cloning": cloning,
        }

    @property
    def loaded(self) -> bool:
        return a100_voice.configured() or self._pipe is not None

    def warm(self) -> None:
        if a100_voice.configured():
            return
        with self._lock:
            self._load_local()

    def synthesize(self, text: str, voice: str | None = None) -> dict:
        text = " ".join((text or "").split())
        voice = voice or self.default_voice
        if not text:
            raise TtsError("ไม่มีข้อความไทยสำหรับสร้างเสียง")
        if voice not in self.voices:
            raise TtsError(f"ไม่รู้จักเสียง {voice} — เลือกได้: {', '.join(self.voices)}")

        cloning = voice.endswith(":clone")
        ref_path = self._ref_path()
        ref_text = self._ref_text()
        if cloning and not ref_path:
            raise TtsError(
                "ยังไม่ได้ตั้งไฟล์เสียงตัวอย่าง — ตั้ง UDTH_VOICE_REF หรือ UDTH_OMNIVOICE_REF "
                "ให้ชี้ไปที่ไฟล์เสียง 5-10 วินาทีก่อน"
            )
        if cloning and not ref_path.is_file():
            raise TtsError(f"ไม่พบไฟล์เสียงตัวอย่าง {ref_path} — ตรวจ UDTH_VOICE_REF ใน .env")

        ref_id = a100_voice.reference_identity(ref_path, ref_text) if cloning and ref_path else ""
        seed = f"{voice}\0{ref_id}\0{text}"
        digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
        filename = f"{digest}.wav"
        output = self.cache_dir / filename
        if output.exists() and output.stat().st_size:
            return {"file": filename, "cached": True}

        if a100_voice.is_available():
            try:
                return a100_voice.synthesize_remote(
                    engine=self.name,
                    voice=voice,
                    text=text,
                    output_path=output,
                    ref_path=ref_path if cloning else None,
                    ref_text=ref_text if cloning else None,
                )
            except a100_voice.A100Unavailable as exc:
                a100_voice.mark_down(str(exc))
                if not _module_available("flowtts"):
                    raise

        with self._lock:
            if output.exists() and output.stat().st_size:
                return {"file": filename, "cached": True}
            pipe, sf, np = self._load_local()
            local_ref = ref_path if cloning else self._ensure_default_ref()
            local_ref_text = (ref_text or DEFAULT_REF_TEXT) if cloning else DEFAULT_REF_TEXT
            try:
                self.cache_dir.mkdir(parents=True, exist_ok=True)
                partial = output.with_name(output.name + ".part.wav")
                if hasattr(pipe, "generate"):
                    audio, sr = pipe.generate(
                        reference_audio=str(local_ref),
                        reference_text=local_ref_text,
                        gen_text=text,
                    )
                    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
                    sf.write(str(partial), samples, sr, format="WAV")
                else:
                    pipe(
                        text=text,
                        ref_voice=str(local_ref),
                        ref_text=local_ref_text,
                        output_file=str(partial),
                    )
                partial.replace(output)
                return {"file": filename, "cached": False}
            except Exception as exc:
                raise TtsError(f"{self.name} สร้างเสียงไม่สำเร็จ: {exc}") from exc

    def _ensure_default_ref(self) -> Path:
        ref = self._ref_path()
        if ref and ref.is_file():
            return ref
        default_wav = self.cache_dir / "flow-default-ref.wav"
        if default_wav.is_file() and default_wav.stat().st_size:
            return default_wav
        raise TtsError(
            f"{self.name} ในเครื่องต้องมีไฟล์เสียงอ้างอิง — ตั้ง UDTH_VOICE_REF ใน .env หรือรันผ่าน Colab A100"
        )

    def _load_local(self):
        def _hf_cached_path(url_or_path, *args, **kwargs):
            s = str(url_or_path)
            if s.startswith("hf://"):
                from huggingface_hub import hf_hub_download

                parts = s[5:].split("/")
                repo_id = f"{parts[0]}/{parts[1]}"
                filename = "/".join(parts[2:])
                return Path(hf_hub_download(repo_id=repo_id, filename=filename, cache_dir=kwargs.get("cache_dir")))
            return Path(s)

        _cp_mod = _make_stub("cached_path", cached_path=_hf_cached_path)
        sys.modules["cached_path"] = _cp_mod
        # Training-only imports of f5-tts; stubbed only when the real package is absent.
        _install_stub("wandb")
        if _install_stub("hydra"):
            _hydra_utils = _make_stub("hydra.utils", get_class=lambda *a, **k: None)
            sys.modules["hydra"].utils = _hydra_utils
            sys.modules["hydra.utils"] = _hydra_utils
        _install_stub("omegaconf", OmegaConf=object)
        _install_stub("datasets", Dataset=object, load_from_disk=lambda *a, **k: None)
        try:
            from flowtts.inference import AudioConfig, FlowTTSPipeline, ModelConfig
            import numpy as np
            import soundfile as sf
            import torch
        except ImportError as exc:
            raise TtsError(
                f"{self.name} ต้องใช้ A100 Voice Server (ตั้ง UDTH_A100_URL) หรือติดตั้ง flowtts ในเครื่อง "
                "(pip install vocos pythainlp pydub einops ema-pytorch torchdiffeq x-transformers rjieba pypinyin jieba "
                "&& pip install --no-deps f5-tts)"
            ) from exc
        if self._pipe is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
            print(f"  กำลังโหลดโมเดล {self.name} ({self.checkpoint}) บน {device} ...", flush=True)
            try:
                self._pipe = FlowTTSPipeline(
                    model_config=ModelConfig(
                        language="th",
                        model_type="F5",
                        checkpoint=str(_hf_cached_path(self.checkpoint)),
                        vocab_file=str(_hf_cached_path(self.vocab)),
                        vocoder="vocos",
                        device=device,
                    ),
                    audio_config=AudioConfig(silence_threshold=-45, cfg_strength=2.5, speed=1.0),
                    temp_dir=str(self.cache_dir / f"temp_{self.name}"),
                )
            except Exception as exc:
                raise TtsError(f"{self.name} โหลดโมเดลในเครื่องไม่สำเร็จ: {exc}") from exc
        return self._pipe, sf, np


class ThonburianTts(_FlowTtsBase):
    name = "thonburian"
    label = "ThonburianTTS megaF5 (A100 / โคลนเสียงได้)"
    voices = THONBURIAN_VOICES
    checkpoint = os.environ.get(
        "UDTH_THONBURIAN_CHECKPOINT",
        "hf://biodatlab/ThonburianTTS/megaF5/mega_f5_last.safetensors",
    )
    vocab = os.environ.get(
        "UDTH_THONBURIAN_VOCAB",
        "hf://biodatlab/ThonburianTTS/megaF5/mega_vocab.txt",
    )
    default_voice = "thonburian:default"


class OpenJaiTts(_FlowTtsBase):
    name = "openjai"
    label = "OpenJaiTTS v1 (A100 / โคลนเสียงได้)"
    voices = OPENJAI_VOICES
    checkpoint = os.environ.get(
        "UDTH_OPENJAI_CHECKPOINT",
        "hf://JTS-AI/OpenJaiTTS-v1.0/model.pt",
    )
    vocab = os.environ.get(
        "UDTH_OPENJAI_VOCAB",
        "hf://JTS-AI/OpenJaiTTS-v1.0/vocab.txt",
    )
    default_voice = "openjai:default"
