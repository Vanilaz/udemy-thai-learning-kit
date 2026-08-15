"""Local translation service the Chrome extension talks to.

Runs on 127.0.0.1 only — nothing is exposed to the network. The extension
posts the English transcript it scraped from the Udemy page; this server
translates it (reusing the same prompts and glossary as the CLI), caches the
result on disk, and hands back Thai subtitle cues.

Translation takes ~30-90s, which is far too long to hold an HTTP request open,
so it runs as a background job the extension polls.

Endpoints
    GET  /health                 -> {"ok": true}
    POST /translate              -> {"job": "<id>", "status": "..."}
    GET  /job/<id>               -> {"status": "pending|running|done|error", ...}
"""

from __future__ import annotations

import hashlib
import json
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .build import _parse_subtitles, _parse_terms, _split_sections
from .glossary import Glossary
from .models import Lesson, Segment

HOST = "127.0.0.1"
PORT = 8765
MAX_BODY_BYTES = 8 * 1024 * 1024

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


class _Handler(BaseHTTPRequestHandler):
    # Injected by serve()
    cache_dir: Path
    glossary_path: Path
    engine: str
    effort: str

    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        return

    # -- CORS ---------------------------------------------------------------

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- Routes -------------------------------------------------------------

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._send(200, {"ok": True, "engine": self.engine})
            return
        if self.path.startswith("/job/"):
            job_id = self.path[len("/job/") :]
            with _jobs_lock:
                job = _jobs.get(job_id)
            if job is None:
                self._send(404, {"error": "ไม่พบงานนี้"})
                return
            self._send(200, job)
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/translate":
            self._send(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._send(400, {"error": "ขนาดข้อมูลไม่ถูกต้อง"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"error": "อ่าน JSON ไม่ได้"})
            return

        cues = payload.get("cues") or []
        if not cues:
            self._send(400, {"error": "ไม่มี cues ส่งมา"})
            return

        title = (payload.get("title") or "บทเรียน").strip()
        course = (payload.get("course") or "udemy").strip()
        # "แปลบทเรียนนี้ใหม่" must be able to beat the cache, otherwise it just
        # hands back the same translation the user was unhappy with.
        force = bool(payload.get("force"))
        # "subtitle" for caption lines, "doc" for article/handout prose.
        mode = "doc" if payload.get("mode") == "doc" else "subtitle"
        # Identify the lesson by its id from the URL, never by its on-screen
        # title: Udemy fills that in asynchronously, so reading it early gives
        # a different string than reading it late — and a title that varies
        # between visits means a cache key that never matches twice.
        lecture = str(payload.get("lecture") or "").strip()
        key = _cache_key(course, f"{lecture}\x00{mode}", cues)

        cached = self.cache_dir / f"{key}.json"
        if cached.exists() and force:
            cached.unlink()
        elif cached.exists():
            self._send(
                200,
                {
                    "job": key,
                    "status": "done",
                    "cached": True,
                    "cues": json.loads(cached.read_text(encoding="utf-8")),
                },
            )
            return

        with _jobs_lock:
            existing = _jobs.get(key)
            if existing and existing["status"] in ("pending", "running"):
                self._send(200, {"job": key, "status": existing["status"]})
                return
            _jobs[key] = {"status": "pending", "progress": 0, "total": len(cues)}

        thread = threading.Thread(
            target=_run_job,
            args=(key, course, title, cues, self.cache_dir, self.glossary_path,
                  self.engine, self.effort, mode),
            daemon=True,
        )
        thread.start()
        self._send(202, {"job": key, "status": "pending"})


def _cache_key(course: str, title: str, cues: list[dict]) -> str:
    """Stable id for a lesson's transcript, so re-watching skips translation."""
    digest = hashlib.sha256()
    digest.update(course.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(title.encode("utf-8"))
    for cue in cues:
        digest.update(b"\x00")
        digest.update(str(cue.get("start", "")).encode("utf-8"))
        digest.update((cue.get("text") or "").encode("utf-8"))
    return digest.hexdigest()[:20]


def _set_job(key: str, **fields) -> None:
    with _jobs_lock:
        job = _jobs.setdefault(key, {})
        job.update(fields)


def _run_job(
    key: str,
    course: str,
    title: str,
    cues: list[dict],
    cache_dir: Path,
    glossary_path: Path,
    engine: str,
    effort: str,
    mode: str = "subtitle",
) -> None:
    try:
        _set_job(key, status="running", progress=0, total=len(cues))
        print(f"  แปล: {title} ({len(cues)} บรรทัด) ...", flush=True)

        segments = [
            Segment(
                id=i,
                text=(cue.get("text") or "").strip(),
                start=_as_float(cue.get("start")),
                end=_as_float(cue.get("end")),
            )
            for i, cue in enumerate(cues, start=1)
        ]
        segments = [s for s in segments if s.text]
        lesson = Lesson(slug=key, title=title, course=course, segments=segments)

        glossary = Glossary(glossary_path)
        answers = _translate(lesson, glossary, engine, effort, key, mode)

        by_id: dict[int, str] = {}
        terms = []
        for answer in answers:
            sections = _split_sections(answer)
            by_id.update(_parse_subtitles(sections.get("SUBTITLES", "")))
            terms.extend(_parse_terms(sections.get("TERMS", ""), lesson.slug))

        if not by_id:
            raise RuntimeError("แปลแล้วแต่อ่านผลลัพธ์ไม่ได้")

        for term in terms:
            glossary.add(term)
        glossary.save()

        result = [
            {
                "start": s.start,
                "end": s.end,
                "en": s.text,
                "th": by_id.get(s.id, ""),
            }
            for s in lesson.segments
        ]

        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / f"{key}.json").write_text(
            json.dumps(result, ensure_ascii=False), encoding="utf-8"
        )

        translated = sum(1 for r in result if r["th"])
        _set_job(key, status="done", cues=result, progress=len(result))
        print(f"  เสร็จ: {title} — แปล {translated}/{len(result)} บรรทัด", flush=True)

    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
        traceback.print_exc()
        _set_job(key, status="error", error=str(exc))


def _translate(
    lesson: Lesson,
    glossary: Glossary,
    engine: str,
    effort: str,
    key: str,
    mode: str = "subtitle",
) -> list[str]:
    """Translate in chunks, returning each chunk's raw answer text."""
    if engine == "claude":
        from .translate_api import translate_text

        return translate_text(lesson, glossary, mode=mode)

    from .translate_agy import translate_text

    def on_progress(done: int, total: int) -> None:
        _set_job(key, progress=done, chunks=total)

    return translate_text(
        lesson, glossary, effort=effort, on_progress=on_progress, mode=mode
    )


def _as_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def serve(
    cache_dir: Path,
    glossary_path: Path,
    engine: str = "agy",
    effort: str = "high",
    port: int = PORT,
) -> None:
    _Handler.cache_dir = cache_dir
    _Handler.glossary_path = glossary_path
    _Handler.engine = engine
    _Handler.effort = effort

    server = ThreadingHTTPServer((HOST, port), _Handler)
    print("=" * 58)
    print("  Udemy TH — เซิร์ฟเวอร์แปลซับ พร้อมทำงาน")
    print("=" * 58)
    print(f"  ที่อยู่ : http://{HOST}:{port}")
    print(f"  เครื่องมือแปล : {engine}")
    print(f"  แคช   : {cache_dir}")
    print()
    print("  เปิดหน้าต่างนี้ค้างไว้ระหว่างเรียน แล้วเปิดวิดีโอใน Udemy ได้เลย")
    print("  ปิดด้วย Ctrl+C")
    print("=" * 58, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nปิดเซิร์ฟเวอร์แล้ว")
    finally:
        server.server_close()
