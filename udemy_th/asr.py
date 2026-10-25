"""Speech-to-Text (ASR) via Colab A100 (Typhoon Whisper / Whisper Large-v3) or local GPU.

Used for:
  1. Auto-transcribing 5-10s instructor reference clips for zero-shot voice cloning
  2. Generating timestamped subtitle cues (`[{start, end, text}]`) from audio/video
     files that have no captions at all (`POST /asr` and `python -m udemy_th asr`)
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import tempfile
import threading
from pathlib import Path

from . import a100_voice
from .google_tts import TtsError

ASR_MODEL_ID = os.environ.get("UDTH_ASR_MODEL", "openai/whisper-large-v3-turbo")
THAI_ASR_MODEL_ID = os.environ.get("UDTH_THAI_ASR_MODEL", "biodatlab/whisper-th-large-v3-combined")

_local_lock = threading.Lock()
_local_pipes: dict[str, object] = {}


def status() -> dict:
    if a100_voice.configured():
        return {
            "configured": True,
            "ready": True,
            "device": "Colab A100",
            "remote": a100_voice.base_url(),
            "error": "",
        }
    missing = [m for m in ("torch", "transformers") if importlib.util.find_spec(m) is None]
    if missing:
        return {
            "configured": False,
            "ready": False,
            "error": f"ต้องต่อ A100 (ตั้ง UDTH_A100_URL) หรือติดตั้ง {', '.join(missing)}",
        }
    return {"configured": True, "ready": True, "device": "local", "error": ""}


def _normalize_cues(raw_cues: list | None, full_text: str) -> list[dict]:
    cues: list[dict] = []
    for item in raw_cues or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        start = float(item.get("start") or 0.0)
        end = float(item.get("end") if item.get("end") is not None else start + 3.0)
        if end <= start:
            end = start + 2.5
        cues.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    if not cues and full_text.strip():
        cues.append({"start": 0.0, "end": 5.0, "text": full_text.strip()})
    return cues


def transcribe_bytes(
    audio_bytes: bytes,
    *,
    lang: str | None = None,
    timestamps: bool = True,
) -> dict:
    """Transcribe raw audio bytes into `{text, lang, cues}`."""
    if not audio_bytes:
        raise TtsError("ไม่มีข้อมูลเสียงสำหรับถอดความ")

    clean_lang = (lang or "").strip().lower().split("-")[0].split("_")[0] or None

    if a100_voice.is_available():
        try:
            reply = a100_voice.request_json(
                "/v1/asr",
                {
                    "audio_b64": base64.b64encode(audio_bytes).decode("ascii"),
                    "lang": clean_lang,
                    "timestamps": bool(timestamps),
                },
                timeout=180.0,
            )
            text = str(reply.get("text") or "").strip()
            detected = str(reply.get("lang") or clean_lang or "en").strip()
            cues = _normalize_cues(reply.get("cues"), text)
            return {"text": text, "lang": detected, "cues": cues}
        except a100_voice.A100Unavailable as exc:
            a100_voice.mark_down(str(exc))
            if importlib.util.find_spec("transformers") is None:
                raise TtsError(f"เซิร์ฟเวอร์ A100 ไม่ตอบ และในเครื่องไม่มีโมเดล Whisper ({exc})") from exc

    return _transcribe_local_bytes(audio_bytes, lang=clean_lang, timestamps=timestamps)


def _transcribe_local_bytes(audio_bytes: bytes, *, lang: str | None, timestamps: bool) -> dict:
    try:
        import torch
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline
    except ImportError as exc:
        raise TtsError("ยังไม่ได้ตั้งค่า UDTH_A100_URL และยังไม่ได้ติดตั้ง transformers/torch ในเครื่อง") from exc

    model_id = THAI_ASR_MODEL_ID if lang == "th" else ASR_MODEL_ID
    with _local_lock:
        pipe = _local_pipes.get(model_id)
        if pipe is None:
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            dtype = torch.float16 if torch.cuda.is_available() else torch.float32
            print(f"  [ASR] กำลังโหลดโมเดล Whisper ({model_id}) บน {device} ...", flush=True)
            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                model_id, torch_dtype=dtype, low_cpu_mem_usage=True
            ).to(device)
            proc = AutoProcessor.from_pretrained(model_id)
            pipe = pipeline(
                "automatic-speech-recognition",
                model=model,
                tokenizer=proc.tokenizer,
                feature_extractor=proc.feature_extractor,
                chunk_length_s=30,
                torch_dtype=dtype,
                device=device,
            )
            _local_pipes[model_id] = pipe

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(audio_bytes)
        try:
            gen_kwargs = {"language": lang} if lang else {}
            out = pipe(str(tmp_path), return_timestamps=bool(timestamps), generate_kwargs=gen_kwargs)
        finally:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    text = str(out.get("text") or "").strip()
    raw_chunks = []
    for chunk in out.get("chunks") or []:
        ts = chunk.get("timestamp") or (0.0, 0.0)
        start = float(ts[0] or 0.0)
        end = float(ts[1] if ts[1] is not None else start + 3.0)
        raw_chunks.append({"start": start, "end": end, "text": str(chunk.get("text") or "").strip()})
    return {
        "text": text,
        "lang": lang or "en",
        "cues": _normalize_cues(raw_chunks, text),
    }


def transcribe_file(
    path: Path,
    *,
    lang: str | None = None,
    timestamps: bool = True,
    cache_dir: Path | None = None,
) -> dict:
    """Transcribe an audio file on disk, caching the result in `cache_dir/asr`."""
    if not path.is_file():
        raise TtsError(f"ไม่พบไฟล์เสียง {path}")
    stat = path.stat()
    seed = f"{path.resolve()}\0{stat.st_size}\0{int(stat.st_mtime)}\0{lang or ''}\0{int(timestamps)}"
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    cached_file = (cache_dir / "asr" / f"{digest}.json") if cache_dir else None
    if cached_file and cached_file.is_file():
        try:
            return json.loads(cached_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass

    result = transcribe_bytes(path.read_bytes(), lang=lang, timestamps=timestamps)
    if cached_file:
        try:
            cached_file.parent.mkdir(parents=True, exist_ok=True)
            cached_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass
    return result
