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
import math
import os
import re
import sys
import time
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .build import _parse_subtitles, _parse_terms, _split_sections
from .env import ENV_PATH, LOADED as ENV_LOADED
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
_store_path: Path | None = None
MAX_PENDING_JOBS = 200
MAX_HISTORY_JOBS = 200

# How many lectures may be translated at the same time.
#
# Each worker runs one `agy` process at a time, and `agy` spends most of a
# lecture waiting on the provider rather than on this machine: measured over
# three real lectures, running them one after another took 56.5s while running
# all three at once took 21.9s (2.58x) with no per-lecture slowdown; five at
# once finished in 26.8s against a ~94s serial baseline (3.51x), by which point
# each individual lecture had started to take noticeably longer.
#
# Three is the point where throughput is won without the lecture the viewer is
# actually waiting for getting slower. Set UDTH_WORKERS=1 to go back to one at
# a time.
WORKER_COUNT = max(1, int(os.environ.get("UDTH_WORKERS", "3")))


class JobCancelled(Exception):
    """Cooperative cancellation; an in-flight provider call may still finish."""


def _atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _persist_jobs() -> None:
    # Called with _cv held. Progress stays in memory; lifecycle changes survive restart.
    if _store_path is None:
        return
    rows = []
    for key, job in _jobs.items():
        args = _job_args.get(key)
        if args is None:
            continue
        rows.append({"id": key, "job": {k: v for k, v in job.items() if k != "cues"},
                     "args": [str(a) if isinstance(a, Path) else a for a in args]})
    _atomic_json(_store_path, {"version": 1, "jobs": rows, "queue": _queue})


def _restore_jobs(cache_dir: Path, glossary_path: Path) -> None:
    global _store_path
    with _cv:
        _store_path = cache_dir / "jobs-state.json"
        _jobs.clear()
        _job_args.clear()
        _queue.clear()
        if not _store_path.exists():
            return
        try:
            data = json.loads(_store_path.read_text(encoding="utf-8"))
            restored = {}
            for row in data["jobs"]:
                key, job, args = row["id"], dict(row["job"]), list(row["args"])
                if not re.fullmatch(r"[a-f0-9]{20}", key) or len(args) != 8:
                    raise ValueError("invalid saved job")
                args[3:5] = [cache_dir, glossary_path]
                if job["status"] == "running":
                    job.update(status="queued", progress=0, resumed=True)
                elif job["status"] == "cancelling":
                    job.update(status="cancelled", cancel_requested=True)
                restored[key] = (job, tuple(args))
            for key, (job, args) in restored.items():
                _jobs[key], _job_args[key] = job, args
            order = list(dict.fromkeys(data.get("queue", []) + list(restored)))
            _queue.extend(k for k in order if k in _jobs and _jobs[k]["status"] == "queued")
            _persist_jobs()
        except (OSError, ValueError, KeyError, TypeError) as exc:
            _jobs.clear()
            _job_args.clear()
            _queue.clear()
            # Preserve the original for diagnosis instead of silently overwriting it.
            raise RuntimeError(f"อ่านประวัติคิวไม่ได้: {_store_path}") from exc


def _check_cancelled(key: str) -> None:
    with _cv:
        if _jobs.get(key, {}).get("cancel_requested"):
            raise JobCancelled()


def _job_action(key: str, action: str) -> str:
    with _cv:
        if key not in _jobs:
            raise KeyError(key)
        job = _jobs[key]
        if action == "cancel":
            if job["status"] == "queued":
                _queue.remove(key)
                job.update(status="cancelled", cancel_requested=True)
            elif job["status"] in ("running", "cancelling"):
                job.update(status="cancelling", cancel_requested=True)
            else:
                raise ValueError("งานนี้ไม่ได้อยู่ระหว่างแปล")
            job["updated_at"] = time.time()
            _persist_jobs()
            return job["status"]
        if job["status"] not in ("error", "cancelled"):
            raise ValueError("ลองใหม่ได้เฉพาะงานที่ผิดพลาดหรือยกเลิกแล้ว")
        return _enqueue(key, job.get("priority", PRIORITY_NOW), job["title"], _job_args[key])


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

    # -- CORS ---------------------------------------------------------------

    def _allowed_origin(self, write: bool = False) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
            return True
        return not write and origin in ("https://www.udemy.com", "https://www.youtube.com")

    def _check_access(self, write: bool = False) -> bool:
        host = self.headers.get("Host", "")
        port = self.server.server_port
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}") or not self._allowed_origin(write):
            self.close_connection = True
            self._send(403, {"error": "ไม่อนุญาตให้หน้านี้เรียกเซิร์ฟเวอร์"})
            return False
        return True

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and self._allowed_origin(self.command in ("POST", "OPTIONS")):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        if not self._check_access(write=True):
            return
        self.send_response(204)
        self._cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- Routes -------------------------------------------------------------

    def do_GET(self):  # noqa: N802
        if not self._check_access():
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
                if snapshot and snapshot["status"] == "done" and "cues" not in snapshot:
                    args = _job_args.get(job_id)
                    result = _read_cached(self.cache_dir / f"{job_id}.json", args[2]) if args else None
                    if result is None:
                        _set_job(job_id, status="error", error="ไฟล์คำแปลหายหรือไม่สมบูรณ์ กดลองใหม่จากคิว")
                        snapshot = dict(_jobs[job_id])
                    else:
                        snapshot["cues"] = result
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
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        if not self._check_access(write=True):
            return
        path = urlparse(self.path).path
        action = re.fullmatch(r"/job/([a-f0-9]{20})/(cancel|retry)", path)
        if path not in ("/translate", "/tts") and not action:
            self.close_connection = True
            self._send(404, {"error": "not found"})
            return

        if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._send(415, {"error": "ต้องส่ง application/json พร้อม Content-Length"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send(400, {"error": "ขนาดข้อมูลไม่ถูกต้อง"})
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"error": "อ่าน JSON ไม่ได้"})
            return

        if not isinstance(payload, dict):
            self._send(400, {"error": "JSON ต้องเป็น object"})
            return

        if action:
            try:
                status = _job_action(*action.groups())
                self._send(200, {"status": status})
            except KeyError:
                self._send(404, {"error": "ไม่พบงานนี้"})
            except ValueError as exc:
                self._send(409, {"error": str(exc)})
            return

        if path == "/tts":
            if not isinstance(payload.get("text"), str) or not isinstance(payload.get("voice"), str):
                self._send(400, {"error": "text และ voice ต้องเป็นข้อความ"})
                return
            self._handle_tts(payload)
            return

        cues = payload.get("cues") or []
        try:
            _validate_translation(payload, cues)
        except ValueError as exc:
            self._send(400, {"error": str(exc)})
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
        result = _read_cached(cached, cues) if not force else None
        if result is not None:
            answer = {"job": key, "status": "done", "cached": True}
            # A batch only wants to know it is already done. Sending back every
            # cue of a dozen lectures nobody is reading yet is pure waste.
            if not batch:
                answer["cues"] = result
            self._send(200, answer)
            return

        try:
            status = _enqueue(
                key, priority=PRIORITY_BATCH if batch else PRIORITY_NOW, title=title,
                args=(course, title, cues, self.cache_dir, self.glossary_path,
                      self.engine, self.effort, mode),
            )
        except ValueError as exc:
            self._send(429, {"error": str(exc)})
            return
        self._send(202, {"job": key, "status": status})

    def _handle_tts(self, payload: dict) -> None:
        voice = str(payload.get("voice") or "") or None
        try:
            # The voice id routes to its engine, so the extension never sends an
            # engine name that could contradict the voice it picked.
            result = self.tts.synthesize(str(payload.get("text") or ""), voice)
        except TtsError as exc:
            self._send(400, {"error": str(exc)})
            return
        self._send(200, {**result, "url": f"/audio/{result['file']}"})


def _validate_translation(payload: dict, cues) -> None:
    if not isinstance(cues, list) or not 1 <= len(cues) <= 20000:
        raise ValueError("cues ต้องเป็นรายการ 1–20000 บรรทัด")
    for field in ("title", "course", "lecture", "mode"):
        if field in payload and not isinstance(payload[field], str):
            raise ValueError(f"{field} ต้องเป็นข้อความ")
    for field in ("batch", "force"):
        if field in payload and not isinstance(payload[field], bool):
            raise ValueError(f"{field} ต้องเป็น boolean")
    for cue in cues:
        if not isinstance(cue, dict) or not isinstance(cue.get("text"), str) or not cue["text"].strip():
            raise ValueError("ทุก cue ต้องมี text ที่ไม่ว่าง")
        times = [cue.get("start"), cue.get("end")]
        if not all(isinstance(t, (int, float)) and not isinstance(t, bool) and math.isfinite(t) for t in times):
            raise ValueError("start และ end ต้องเป็นเวลาที่ถูกต้อง")
        if times[0] < 0 or times[1] <= times[0]:
            raise ValueError("end ต้องมากกว่า start และเวลาต้องไม่ติดลบ")


def _read_cached(path: Path, cues: list[dict]) -> list[dict] | None:
    try:
        result = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(result, list) or len(result) != len(cues):
            return None
        for row, cue in zip(result, cues):
            if (not isinstance(row, dict) or not isinstance(row.get("th"), str) or not row["th"].strip()
                    or row.get("en") != cue["text"].strip()
                    or row.get("start") != cue["start"] or row.get("end") != cue["end"]):
                return None
        return result
    except (OSError, ValueError):
        return None


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
        if "status" in fields:
            job["updated_at"] = time.time()
            _persist_jobs()


def _enqueue(key: str, priority: int, title: str, args: tuple) -> str:
    """Queue a translation, or join the one already queued for the same key."""
    with _cv:
        existing = _jobs.get(key)
        if existing and existing["status"] in ("queued", "running", "cancelling"):
            # Already waiting because a batch queued it. If the user has now
            # opened that very lecture, move it to the front of the queue
            # instead of making them wait out everything ahead of it.
            if priority < existing.get("priority", PRIORITY_BATCH):
                existing["priority"] = priority
                _persist_jobs()
            return existing["status"]

        if len(_queue) >= MAX_PENDING_JOBS:
            raise ValueError("คิวเต็มแล้ว รอให้งานเดิมเสร็จก่อน")
        terminal = [k for k, j in _jobs.items() if j["status"] in ("done", "error", "cancelled")]
        for old in terminal[:max(0, len(terminal) - MAX_HISTORY_JOBS + 1)]:
            _jobs.pop(old, None)
            _job_args.pop(old, None)

        _jobs[key] = {
            "status": "queued",
            "progress": 0,
            "total": len(args[2]),
            "priority": priority,
            "title": title,
            "course": args[0],
            "updated_at": time.time(),
        }
        _job_args[key] = args
        _queue.append(key)
        _persist_jobs()
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
            args = _job_args.get(key)
            _set_job(key, status="running")
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
        running_count = 0
        done = failed = 0
        for job in _jobs.values():
            if job["status"] in ("running", "cancelling"):
                running_count += 1
                # One representative for the "now translating: X" line. Several
                # lectures run at once, so the count beside it is what tells
                # the real story; `jobs` below lists every one of them.
                if running is None:
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
            "jobs": [
                {"id": key, **{k: v for k, v in job.items() if k not in ("cues", "cancel_requested")}}
                for key, job in sorted(_jobs.items(), key=lambda item: (
                    item[1]["status"] not in ("running", "cancelling", "queued"),
                    item[1].get("priority", 1) if item[1]["status"] == "queued" else -1,
                    -item[1].get("updated_at", 0)))
            ],
            "running": running,
            "running_count": running_count,
            "workers": WORKER_COUNT,
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
        _check_cancelled(key)
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
            _check_cancelled(key)
            partial.update(_parse_subtitles(_split_sections(answer).get("SUBTITLES", "")))
            _set_job(key, cues=_render_cues(lesson, partial))

        answers = _translate(lesson, glossary, engine, effort, key, mode, publish)

        by_id: dict[int, str] = {}
        terms = []
        for answer in answers:
            sections = _split_sections(answer)
            by_id.update(_parse_subtitles(sections.get("SUBTITLES", "")))
            terms.extend(_parse_terms(sections.get("TERMS", ""), lesson.slug))

        _check_cancelled(key)
        missing = [s for s in segments if not by_id.get(s.id)]
        if missing:
            _set_job(key, missing=len(missing), phase="repairing")
            repair = Lesson(slug=key, title=title, course=course, segments=missing)
            partial.update(by_id)
            for answer in _translate(repair, glossary, engine, effort, key, mode, publish):
                sections = _split_sections(answer)
                # A repair cannot replace already accepted lines.
                repaired = _parse_subtitles(sections.get("SUBTITLES", ""))
                by_id.update({s.id: repaired[s.id] for s in missing if repaired.get(s.id)})
                terms.extend(_parse_terms(sections.get("TERMS", ""), lesson.slug))
            missing = [s for s in segments if not by_id.get(s.id)]
            _set_job(key, missing=len(missing), cues=_render_cues(lesson, by_id))
            if missing:
                raise RuntimeError(f"คำแปลยังขาด {len(missing)}/{len(segments)} บรรทัดหลังลองซ่อม กดลองใหม่ได้จากคิว")

        with _cv:
            _check_cancelled(key)
            # Re-read instead of saving the copy loaded before translating.
            # That copy is minutes old, and while this lecture was being
            # translated another worker may have added terms of its own —
            # writing this snapshot back over them would silently drop them.
            merged = Glossary(glossary_path)
            for term in terms:
                merged.add(term)
            merged.save()
            result = _render_cues(lesson, by_id)
            _atomic_json(cache_dir / f"{key}.json", result)
            translated = sum(1 for r in result if r["th"])
            _set_job(key, status="done", cues=result, progress=len(result), missing=0, phase="complete")
        print(f"  เสร็จ: {title} — แปล {translated}/{len(result)} บรรทัด", flush=True)

    except JobCancelled:
        _set_job(key, status="cancelled")
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
        if _jobs.get(key, {}).get("cancel_requested"):
            _set_job(key, status="cancelled")
            return
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
    _Handler.tts = TtsRegistry(cache_dir)
    server = _Server((HOST, port), _Handler)
    _restore_jobs(cache_dir, glossary_path)
    for index in range(WORKER_COUNT):
        threading.Thread(
            target=_worker, daemon=True, name=f"udth-worker-{index + 1}"
        ).start()
    print("=" * 58)
    print("  Udemy TH — เซิร์ฟเวอร์แปลซับและเสียงพากย์ พร้อมทำงาน")
    print("=" * 58)
    print(f"  ที่อยู่ : http://{HOST}:{port}")
    print(f"  เครื่องมือแปล : {engine} (แปลพร้อมกัน {WORKER_COUNT} บทเรียน)")
    print(f"  แคช   : {cache_dir}")
    if ENV_LOADED:
        print(f"  ตั้งค่าจาก : {ENV_PATH} ({', '.join(sorted(ENV_LOADED))})")
    elif ENV_PATH.exists():
        print(f"  ตั้งค่าจาก : {ENV_PATH} (ไม่ได้ใช้ค่าใดเลย — ถูกตั้งใน environment อยู่แล้ว)")
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
