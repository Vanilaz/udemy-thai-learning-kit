"""Google Cloud Chirp 3 HD synthesis with a local, quota-aware MP3 cache."""

from __future__ import annotations

import hashlib
import json
import os
import threading
from datetime import datetime
from pathlib import Path

NAME = "google"
DEFAULT_VOICE = "th-TH-Chirp3-HD-Gacrux"
VOICES = {
    "th-TH-Chirp3-HD-Gacrux": "Gacrux — หญิง",
    "th-TH-Chirp3-HD-Iapetus": "Iapetus — ชาย",
    "th-TH-Chirp3-HD-Orus": "Orus — ชาย",
}
# Stay below Google's 1,000,000 monthly free allowance.  Deliberately
# conservative: the server refuses to send anything once this local count is
# reached, rather than finding out from a bill.
DEFAULT_MONTHLY_LIMIT = 900_000

# Counted in BYTES, not characters.  Google's own quota documentation states
# limits in bytes and notes that one character is several bytes in some
# locales — Thai is 3 bytes per character in UTF-8, so counting characters
# would undercount usage threefold and sail straight past the free tier.
#
# If Google is in fact billing per character, this only makes the local cap
# arrive early, which is the harmless direction to be wrong in.
MAX_REQUEST_BYTES = 5_000


class TtsError(RuntimeError):
    """An error that is safe to show in the extension UI."""


class GoogleTts:
    name = NAME
    label = "Google Chirp 3 HD"
    voices = VOICES

    def __init__(self, cache_dir: Path, monthly_limit: int | None = None):
        self.cache_dir = cache_dir / "audio"
        self.usage_path = self.cache_dir / "usage.json"
        self.monthly_limit = monthly_limit or int(
            os.environ.get("UDTH_TTS_MONTHLY_LIMIT", DEFAULT_MONTHLY_LIMIT)
        )
        self._lock = threading.Lock()

    def status(self) -> dict:
        try:
            self._client_and_types()
        except TtsError as exc:
            if self.key_path():
                return {"configured": False, "error": str(exc)}

            configured = self._configured_path()
            if configured:
                # The commonest cause by far: a re-downloaded key arrives under
                # Google's own generated filename and the old path now points
                # at nothing.
                return {
                    "configured": False,
                    "error": (
                        f"ตั้ง GOOGLE_APPLICATION_CREDENTIALS ไว้ที่ {configured} "
                        "แต่ไม่พบไฟล์นั้น (ดาวน์โหลด key ใหม่แล้วชื่อไฟล์เปลี่ยนหรือเปล่า?) "
                        "— ชี้ไปที่ไฟล์ใหม่ หรือชี้ไปที่โฟลเดอร์ที่เก็บ key ก็ได้"
                    ),
                }
            return {
                "configured": False,
                "error": (
                    "ยังไม่ได้ตั้งค่า Google Cloud credentials — วางไฟล์ key ไว้ที่ "
                    "google-key.json ในโฟลเดอร์โปรเจกต์ หรือตั้ง GOOGLE_APPLICATION_CREDENTIALS "
                    "แบบถาวรใน Windows Environment Variables (ดู docs/google-cloud-tts.md)"
                ),
            }

        with self._lock:
            usage = self._usage()
        return {
            "configured": True,
            "voice": DEFAULT_VOICE,
            "used": usage["bytes"],
            "characters": usage["characters"],
            "limit": self.monthly_limit,
            "remaining": max(0, self.monthly_limit - usage["bytes"]),
            "unit": "bytes",
        }

    def synthesize(self, text: str, voice: str | None = DEFAULT_VOICE) -> dict:
        text = " ".join(text.split())
        voice = voice or DEFAULT_VOICE
        if not text:
            raise TtsError("ไม่มีข้อความไทยสำหรับสร้างเสียง")
        if not voice.startswith("th-TH-Chirp3-HD-"):
            raise TtsError("เลือกได้เฉพาะเสียงไทย Google Chirp 3 HD")

        digest = hashlib.sha256(f"{voice}\0{text}".encode("utf-8")).hexdigest()[:24]
        filename = f"{digest}.mp3"
        output = self.cache_dir / filename
        if output.exists() and output.stat().st_size:
            return {"file": filename, "cached": True}

        # Serialising synthesis keeps the on-disk usage counter exact and makes
        # simultaneous prefetch/play requests for one cue harmless.
        with self._lock:
            if output.exists() and output.stat().st_size:
                return {"file": filename, "cached": True}

            payload = text.encode("utf-8")
            if len(payload) > MAX_REQUEST_BYTES:
                raise TtsError(
                    f"ข้อความยาวเกินที่ Google รับได้ ({len(payload):,} ไบต์ "
                    f"เกิน {MAX_REQUEST_BYTES:,})"
                )

            usage = self._usage()
            if usage["bytes"] + len(payload) > self.monthly_limit:
                raise TtsError(
                    "ใช้โควต้าเสียงเดือนนี้ถึงขีดจำกัดที่ตั้งไว้แล้ว "
                    f"({self.monthly_limit:,} ไบต์) — ตัวนับนี้อยู่ในเครื่อง "
                    "ตัวเลขจริงต้องดูที่ Google Cloud Console"
                )

            client, tts = self._client_and_types()
            try:
                response = client.synthesize_speech(
                    input=tts.SynthesisInput(text=text),
                    voice=tts.VoiceSelectionParams(language_code="th-TH", name=voice),
                    audio_config=tts.AudioConfig(audio_encoding=tts.AudioEncoding.MP3),
                )
            except Exception as exc:  # provider errors are made actionable below
                raise TtsError(f"Google Cloud สร้างเสียงไม่สำเร็จ: {exc}") from exc

            self.cache_dir.mkdir(parents=True, exist_ok=True)
            output.write_bytes(response.audio_content)
            usage["bytes"] += len(payload)
            usage["characters"] += len(text)
            self._save_usage(usage)
            return {"file": filename, "cached": False}

    def _usage(self) -> dict:
        month = datetime.now().strftime("%Y-%m")
        try:
            usage = json.loads(self.usage_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            usage = {}
        if usage.get("month") != month:
            return {"month": month, "bytes": 0, "characters": 0}

        characters = int(usage.get("characters", 0))
        # Counters written before the switch to bytes recorded characters only.
        # Assume the worst case for Thai (3 bytes each) rather than treating
        # that history as if it had cost nothing.
        stored_bytes = usage.get("bytes")
        return {
            "month": month,
            "bytes": int(stored_bytes) if stored_bytes is not None else characters * 3,
            "characters": characters,
        }

    def _save_usage(self, usage: dict) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.usage_path.write_text(json.dumps(usage), encoding="utf-8")

    @staticmethod
    def _service_account_in(folder: Path) -> Path | None:
        """The service-account JSON inside a directory, if exactly one is there.

        Google Cloud names downloaded keys after the project and a random
        suffix, so pointing at the folder survives re-downloading a key — which
        renames the file and silently breaks a path that names it directly.
        """
        try:
            candidates = sorted(folder.glob("*.json"))
        except OSError:
            return None
        for path in candidates:
            try:
                if '"service_account"' in path.read_text(encoding="utf-8", errors="ignore"):
                    return path
            except OSError:
                continue
        return None

    @classmethod
    def key_path(cls) -> Path | None:
        """Where the service-account JSON is, if it can be found at all.

        `set GOOGLE_APPLICATION_CREDENTIALS=...` in a Command Prompt applies to
        that window and its children only, so a server started from Explorer or
        from a different window never sees it — which looks exactly like having
        no credentials. Project-owned locations are therefore checked too,
        neither of which depends on how the server happened to be launched.

        A configured path may name a file *or* the folder holding it.
        """
        for name in ("UDTH_GOOGLE_KEY", "GOOGLE_APPLICATION_CREDENTIALS"):
            value = os.environ.get(name)
            if not value:
                continue
            path = Path(value)
            if path.is_file():
                return path
            # Named a folder, or named a file that has since been renamed —
            # look for the key beside where it was expected either way.
            folder = path if path.is_dir() else path.parent
            found = cls._service_account_in(folder)
            if found:
                return found

        # Project root, two levels up from this file. Kept out of git by
        # .gitignore — a service-account key must never be committed.
        local = Path(__file__).resolve().parent.parent / "google-key.json"
        return local if local.is_file() else None

    @staticmethod
    def _configured_path() -> str:
        """What the environment *says* the key path is, whether or not it exists.

        Kept separate from key_path() so "configured but the file is gone" can
        be reported as itself, instead of as "you never set it up" — which sent
        the user hunting for a setting that was already correct.
        """
        for name in ("UDTH_GOOGLE_KEY", "GOOGLE_APPLICATION_CREDENTIALS"):
            value = os.environ.get(name)
            if value:
                return value
        return ""

    @classmethod
    def _client_and_types(cls):
        try:
            from google.cloud import texttospeech
        except ImportError as exc:
            raise TtsError(
                "ยังไม่ได้ติดตั้ง Google Cloud TTS — รัน pip install -r requirements.txt"
            ) from exc

        key = cls.key_path()
        try:
            if key:
                client = texttospeech.TextToSpeechClient.from_service_account_file(str(key))
            else:
                # No explicit key: fall back to whatever ambient credentials
                # exist (gcloud auth application-default login, GCE metadata).
                client = texttospeech.TextToSpeechClient()
            return client, texttospeech
        except Exception as exc:
            # The underlying reason used to be swallowed, which turned every
            # cause — wrong path, revoked key, disabled API — into one
            # unactionable sentence.
            where = f"ใช้ไฟล์ {key}" if key else "ไม่พบไฟล์ key"
            raise TtsError(
                f"ตั้งค่า Google Cloud credentials ไม่สำเร็จ ({where}): "
                f"{type(exc).__name__}: {str(exc)[:160]} — ดู docs/google-cloud-tts.md"
            ) from exc
