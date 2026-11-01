"""Bounded local diagnostics. Never store request bodies or authentication headers."""
import json
import logging
from logging.handlers import RotatingFileHandler
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

_lock = threading.Lock()


def redact(value) -> str:
    text = str(value)
    text = re.sub(r"(?:https?|wss?)://[^\s\"'<>]+", lambda m: m[0].split("?", 1)[0].split("#", 1)[0], text)
    text = re.sub(r"(://)[^/@\s]+@", r"\1[REDACTED]@", text)
    text = re.sub(r"(?i)(?:authorization\s*[:=]\s*)?bearer\s+\S+", "Bearer [REDACTED]", text)
    text = re.sub(r"sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]+", "[REDACTED]", text)
    text = re.sub(r"(?i)((?:api[_-]?key|password|token|secret|key|credential)[\"']?\s*[:=]\s*[\"']?)[^\"'\s,;}]+", r"\1[REDACTED]", text)
    return text[:1000]


def write(cache_dir: Path, event: dict) -> None:
    record = {"time": datetime.now(timezone.utc).isoformat(),
              "source": redact(event.get("source", "unknown"))[:50],
              "message": redact(event.get("message", "")),
              "path": redact(event.get("path", "")).split("?", 1)[0][:160]}
    if isinstance(event.get("status"), int):
        record["status"] = event["status"]
    if isinstance(event.get("time"), str):
        record["client_time"] = redact(event["time"])[:40]
    try:
        with _lock:
            path = cache_dir / "logs" / "errors.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(path, maxBytes=1_000_000, backupCount=3, encoding="utf-8")
            try:
                handler.setFormatter(logging.Formatter("%(message)s"))
                handler.emit(logging.LogRecord("udth.errors", logging.ERROR, "", 0,
                                               json.dumps(record, ensure_ascii=False), (), None))
            finally:
                handler.close()
    except OSError:
        pass  # a logging failure must never stop translation or playback
