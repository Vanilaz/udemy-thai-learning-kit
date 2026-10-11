"""Local translation service the Chrome extension talks to.

Runs on 127.0.0.1 only — nothing is exposed to the network. The extension
posts the English transcript it scraped from the Udemy page; this server
translates it (reusing the same prompts and glossary as the CLI), caches the
result on disk, and hands back Thai subtitle cues.

Translation takes ~30-90s, which is far too long to hold an HTTP request open,
so it runs as a background job the extension polls.

Jobs run one at a time on a single worker. Translating a whole section means
queueing a dozen lectures at once, and running those in parallel would start a
dozen `agy` processes competing for the machine — and have them race each other
writing the shared glossary file. A queue also lets the lecture the user is
actually watching jump ahead of the batch.

Endpoints
    GET  /health                 -> {"ok": true}
    GET  /queue                  -> {"running": {...}, "queued": n, ...}
    POST /translate              -> {"job": "<id>", "status": "..."}
    GET  /job/<id>               -> {"status": "queued|running|done|error", ...}
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .build import _parse_subtitles, _parse_terms, _split_sections
from .glossary import Glossary
from .models import Lesson, Segment
from .google_tts import TtsError
from .tts import TtsRegistry

HOST = "127.0.0.1"
PORT = 8765
MAX_BODY_BYTES = 8 * 1024 * 1024

# Lower number runs first. The lecture on screen must not wait behind a batch
# that was queued to be watched later.
PRIORITY_NOW = 0
PRIORITY_BATCH = 1

# Public job records, exactly as handed to the extension — keep them JSON-safe.
_jobs: dict[str, dict] = {}
# What each queued job needs in order to run, kept out of the public record.
_job_args: dict[str, tuple] = {}
_queue: list[str] = []
# Guards all three of the above, and wakes the worker when work arrives.
_cv = threading.Condition()


# Only the Chrome extension (and plain tools such as curl, which send no Origin
# header) may talk to this server. A server on 127.0.0.1 with "Allow-Origin: *"
# can be driven by ANY web page you happen to have open: it could queue
# translation jobs on your machine (burning your agy / API quota) or ask for
# speech synthesis. Browsers always attach an Origin to cross-site requests,
# so refusing every origin that is not the extension closes that door.
_EXTENSION_ORIGIN_PREFIX = "chrome-extension://"
_ALLOWED_HOSTS = ("127.0.0.1", "localhost")


def origin_allowed(origin: str | None) -> bool:
    return not origin or origin.startswith(_EXTENSION_ORIGIN_PREFIX)


def host_allowed(host_header: str | None) -> bool:
    """Reject DNS-rebinding: the Host must be the loopback name we bound to."""
    if not host_header:
        return True
    return host_header.rsplit(":", 1)[0].strip("[]") in _ALLOWED_HOSTS


class _Handler(BaseHTTPRequestHandler):
    # Injected by serve()
    cache_dir: Path
    glossary_path: Path
    engine: str
    effort: str
    tts: TtsRegistry

    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter console
        return

    def _cors_origin(self) -> str:
        """Echo the extension's own origin back; never a wildcard."""
        return self.headers.get("Origin") or "null"

    def _forbidden(self) -> bool:
        """Answer 403 and return True when this caller must be refused."""
        if origin_allowed(self.headers.get("Origin")) and host_allowed(self.headers.get("Host")):
            return False
        body = json.dumps({"error": "forbidden"}).encode("utf-8")
        self.send_response(403)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    # -- CORS ---------------------------------------------------------------

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        if self._forbidden():
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- Routes -------------------------------------------------------------

    def do_GET(self):  # noqa: N802
        if self._forbidden():
            return
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "engine": self.engine, "voices": self.tts.catalogue()})
            return
        if path == "/voices":
            self._send(200, {"engines": self.tts.catalogue()})
            return
        if path == "/queue":
            self._send(200, _queue_summary())
            return
        if path.startswith("/job/"):
            job_id = path[len("/job/") :]
            with _cv:
                job = _jobs.get(job_id)
                snapshot = dict(job) if job else None
            if snapshot is None:
                self._send(404, {"error": "ไม่พบงานนี้"})
                return
            self._send(200, snapshot)
            return
        if path.startswith("/audio/"):
            self._send_audio(path[len("/audio/") :])
            return
        self._send(404, {"error": "not found"})

    # Hosted engines return MP3; the local model writes WAV, since encoding to
    # MP3 would cost a dependency for a file that never leaves this machine.
    AUDIO_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav"}

    def _send_audio(self, filename: str) -> None:
        # The filename is generated by an engine, never supplied as a path.
        filename = unquote(filename)
        suffix = Path(filename).suffix
        if suffix not in self.AUDIO_TYPES or "/" in filename or "\\" in filename:
            self._send(404, {"error": "not found"})
            return
        path = self.cache_dir / "audio" / filename
        try:
            body = path.read_bytes()
        except FileNotFoundError:
            self._send(404, {"error": "ไม่พบไฟล์เสียง"})
            return
        self.send_response(200)
        self.send_header("Content-Type", self.AUDIO_TYPES[suffix])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        if self._forbidden():
            return
        path = urlparse(self.path).path
        if path not in ("/translate", "/tts", "/tts/warmup"):
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

        if path == "/tts":
            self._handle_tts(payload)
            return

        if path == "/tts/warmup":
            engine = str(payload.get("engine") or "")
            self._send(200, self.tts.warmup(engine) if engine else {"state": "none", "error": ""})
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
        # A section batch is queued for later watching, so it yields to whatever
        # the user has open right now.
        batch = bool(payload.get("batch"))
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
            answer = {"job": key, "status": "done", "cached": True}
            # A batch only wants to know it is already done. Sending back every
            # cue of a dozen lectures nobody is reading yet is pure waste.
            if not batch:
                answer["cues"] = json.loads(cached.read_text(encoding="utf-8"))
            self._send(200, answer)
            return

        status = _enqueue(
            key,
            priority=PRIORITY_BATCH if batch else PRIORITY_NOW,
            title=title,
            args=(course, title, cues, self.cache_dir, self.glossary_path,
                  self.engine, self.effort, mode),
        )
        self._send(202, {"job": key, "status": status})

    def _handle_tts(self, payload: dict) -> None:
        voice = str(payload.get("voice") or "") or None
        try:
            # The voice id routes to its engine, so the extension never sends an
            # engine name that could contradict the voice it picked.
            # source_lang set means the text is the original, not Thai: only
            # an engine that can translate (Seamless T2ST) accepts that.
            source_lang = str(payload.get("source_lang") or "") or None
            result = self.tts.synthesize(str(payload.get("text") or ""), voice, source_lang)
        except TtsError as exc:
            self._send(400, {"error": str(exc)})
            return
        self._send(200, {**result, "url": f"/audio/{result['file']}"})


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
    with _cv:
        job = _jobs.setdefault(key, {})
        job.update(fields)


def _enqueue(key: str, priority: int, title: str, args: tuple) -> str:
    """Queue a translation, or join the one already queued for the same key."""
    with _cv:
        existing = _jobs.get(key)
        if existing and existing["status"] in ("queued", "running"):
            # Already waiting because a batch queued it. If the user has now
            # opened that very lecture, move it to the front of the queue
            # instead of making them wait out everything ahead of it.
            if priority < existing.get("priority", PRIORITY_BATCH):
                existing["priority"] = priority
            return existing["status"]

        _jobs[key] = {
            "status": "queued",
            "progress": 0,
            "total": len(args[2]),
            "priority": priority,
            "title": title,
        }
        _job_args[key] = args
        _queue.append(key)
        _cv.notify()
        return "queued"


def _worker() -> None:
    while True:
        with _cv:
            while not _queue:
                _cv.wait()
            # Lowest priority value wins; ties fall back to arrival order.
            index = min(
                range(len(_queue)),
                key=lambda i: (_jobs[_queue[i]].get("priority", PRIORITY_BATCH), i),
            )
            key = _queue.pop(index)
            args = _job_args.pop(key, None)
            waiting = len(_queue)

        if args is None:
            continue
        if waiting:
            print(f"  (คิวเหลืออีก {waiting} บทเรียน)", flush=True)
        _run_job(key, *args)


def _queue_summary() -> dict:
    """What the extension shows while a section is being translated."""
    with _cv:
        running = None
        done = failed = 0
        for job in _jobs.values():
            if job["status"] == "running":
                running = {
                    "title": job.get("title", ""),
                    "progress": job.get("progress", 0),
                    "chunks": job.get("chunks", 0),
                }
            elif job["status"] == "done":
                done += 1
            elif job["status"] == "error":
                failed += 1
        return {
            "running": running,
            "queued": len(_queue),
            "done": done,
            "failed": failed,
            # Preview the next few in the order the worker will actually take
            # them, not the order they arrived in.
            "waiting": [
                _jobs[k].get("title", "")
                for k in sorted(
                    _queue,
                    key=lambda k: (
                        _jobs[k].get("priority", PRIORITY_BATCH),
                        _queue.index(k),
                    ),
                )[:3]
            ],
        }


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

        # Publish each chunk the moment it lands, so the page can start showing
        # subtitles for the part of the lecture that is ready instead of
        # waiting out the whole thing. Chunks finish out of order when they run
        # in parallel, so what is published is "whatever has arrived", and the
        # page decides whether that covers where the viewer actually is.
        partial: dict[int, str] = {}

        def publish(_index: int, answer: str) -> None:
            partial.update(_parse_subtitles(_split_sections(answer).get("SUBTITLES", "")))
            _set_job(key, cues=_render_cues(lesson, partial))

        answers = _translate(lesson, glossary, engine, effort, key, mode, publish)

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

        result = _render_cues(lesson, by_id)

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


class _Server(ThreadingHTTPServer):
    """Threading server that does not shout about clients hanging up.

    A browser closes connections all the time — navigating away, closing the
    tab, letting a keep-alive lapse — and the socket layer raises when the
    reply has nowhere to go. socketserver's default is to print a full
    traceback for each one, which buries the errors that actually matter under
    pages of noise about nothing.
    """

    daemon_threads = True  # never let a stuck request block Ctrl+C

    def handle_error(self, request, client_address):  # noqa: D102
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, ConnectionAbortedError,
                              BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def _render_cues(lesson: Lesson, by_id: dict[int, str]) -> list[dict]:
    """The cue list as the extension consumes it.

    Lines with no translation yet carry an empty `th`; the page falls back to
    the English for those, which is what makes a partial result usable rather
    than merely visible.
    """
    return [
        {"start": s.start, "end": s.end, "en": s.text, "th": by_id.get(s.id, "")}
        for s in lesson.segments
    ]


# Subtitles are short spoken sentences; the deep reasoning pass that "high"
# buys pays off on handout prose and quiz wording, not on caption lines, where
# it mostly doubles the wait. Documents and quizzes keep the careful setting.
SUBTITLE_EFFORT = "medium"


def _translate(
    lesson: Lesson,
    glossary: Glossary,
    engine: str,
    effort: str,
    key: str,
    mode: str = "subtitle",
    on_chunk=None,
) -> list[str]:
    """Translate in chunks, returning each chunk's raw answer text."""
    if engine == "claude":
        from .translate_api import translate_text

        # The API path has no per-chunk hook yet, so it publishes nothing early.
        return translate_text(lesson, glossary, mode=mode)

    from .translate_agy import translate_text

    def on_progress(done: int, total: int) -> None:
        _set_job(key, progress=done, chunks=total)

    # Never raise the configured effort — a user who asked for "low" meant it.
    if mode == "subtitle" and effort == "high":
        effort = SUBTITLE_EFFORT

    return translate_text(
        lesson,
        glossary,
        effort=effort,
        on_progress=on_progress,
        mode=mode,
        on_chunk=on_chunk,
    )


def _as_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _suppress_windows_error_dialogs() -> None:
    # A broken native dependency (e.g. a torchaudio built for another torch)
    # otherwise pops a modal "Entry Point Not Found" box that freezes the
    # server until someone clicks OK. With SEM_FAILCRITICALERRORS the failure
    # comes back as an ordinary import error and that engine reports itself
    # unavailable instead.
    if sys.platform != "win32":
        return
    try:
        import ctypes

        SEM_FAILCRITICALERRORS = 0x0001
        SEM_NOOPENFILEERRORBOX = 0x8000
        ctypes.windll.kernel32.SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX)
    except Exception:
        pass


def serve(
    cache_dir: Path,
    glossary_path: Path,
    engine: str = "agy",
    effort: str = "high",
    port: int = PORT,
) -> None:
    _suppress_windows_error_dialogs()
    _Handler.cache_dir = cache_dir
    _Handler.glossary_path = glossary_path
    _Handler.engine = engine
    _Handler.effort = effort
    _Handler.tts = TtsRegistry(cache_dir)

    threading.Thread(target=_worker, daemon=True, name="udth-worker").start()

    server = _Server((HOST, port), _Handler)
    print("=" * 58)
    print("  Udemy TH — เซิร์ฟเวอร์แปลซับและเสียงพากย์ พร้อมทำงาน")
    print("=" * 58)
    print(f"  ที่อยู่ : http://{HOST}:{port}")
    print(f"  เครื่องมือแปล : {engine}")
    print(f"  แคช   : {cache_dir}")
    print()
    print("  เปิดหน้าต่างนี้ค้างไว้ระหว่างเรียน แล้วเปิดวิดีโอใน Udemy ได้เลย")
    print("  ปิดด้วย Ctrl+C")
    print("=" * 58, flush=True)
    # Local voice models load onto the GPU now, not when the first lecture
    # asks — the server is already answering while this runs.
    _Handler.tts.preload(os.environ.get("UDTH_PRELOAD", "auto"))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nปิดเซิร์ฟเวอร์แล้ว")
    finally:
        server.server_close()
