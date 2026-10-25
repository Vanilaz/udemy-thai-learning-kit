"""Translate through an OpenAI-compatible chat endpoint — e.g. 9router, OpenRouter,
Ollama, vLLM, or custom OpenAI-compatible gateways.

    UDTH_LLM_URL / OPENAI_BASE_URL    base URL ending in /v1 (e.g. https://api.sunisaphas.com/v1, http://localhost:11434)
    UDTH_LLM_KEY / OPENAI_API_KEY    the API key for the endpoint (if required)
    UDTH_LLM_MODEL / OPENAI_MODEL     model name (optional: auto-discovered from /models)

Only the transport differs from the agy path: the same chunks, prompt and
answer format go through translate_agy.translate_text, so focus ordering,
parallel chunks and early publishing all apply unchanged.

A remote API or rented GPU comes and goes, so this is never the only way to translate:
`with_fallback` sends a chunk to agy whenever the endpoint cannot be reached, and
stops trying the endpoint for a while instead of making every chunk wait out a timeout first.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable

Runner = Callable[[str, str], str]

# Transcript characters per chunk.
CHUNK_CHARS = max(1000, int(os.environ.get("UDTH_LLM_CHUNK_CHARS", "6000")))
TIMEOUT_SECONDS = 600
# Requests are batched on the server, so many chunks at once finishes sooner.
PARALLEL = max(1, int(os.environ.get("UDTH_LLM_PARALLEL", "8")))
# After the endpoint fails to answer, go straight to agy for this long.
RETRY_AFTER_SECONDS = 120


class LlmUnavailable(RuntimeError):
    """The endpoint could not be reached (not a wrong answer or a bad key)."""


def normalize_url(url: str) -> str:
    """Ensure base URL ends in /v1 (standard for OpenAI-compatible endpoints including Ollama and 9router)."""
    raw = (url or "").strip().rstrip("/")
    if not raw:
        return ""
    if not raw.endswith("/v1"):
        raw = f"{raw}/v1"
    return raw


def get_url() -> str:
    return normalize_url(
        os.environ.get("UDTH_LLM_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("OPENAI_API_BASE")
        or os.environ.get("OLLAMA_HOST")
        or ""
    )


def get_key() -> str:
    return (
        os.environ.get("UDTH_LLM_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or os.environ.get("OPENROUTER_API_KEY")
        or ""
    )


def get_model() -> str:
    return (
        os.environ.get("UDTH_LLM_MODEL")
        or os.environ.get("OPENAI_MODEL")
        or os.environ.get("OLLAMA_MODEL")
        or ""
    )


def get_fallback_model() -> str:
    return (
        os.environ.get("UDTH_LLM_FALLBACK_MODEL")
        or os.environ.get("OPENAI_FALLBACK_MODEL")
        or ""
    )


def configured() -> bool:
    return bool(get_url())


def describe() -> str:
    model = get_model() or "auto"
    fallback = get_fallback_model()
    fallback_desc = f" (สำรอง: {fallback})" if fallback else ""
    return f"LLM {model}{fallback_desc} ที่ {get_url()}"


def clean_llm_response(text: str) -> str:
    """Clean LLM output: strip <think>...</think> reasoning tags and markdown code block fences."""
    text = (text or "").strip()
    # Strip <think>...</think> reasoning tokens from reasoning models (e.g. DeepSeek-R1)
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    # Strip enclosing markdown code block fences
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[0].startswith("```") and lines[-1].strip() == "```":
            text = "\n".join(lines[1:-1]).strip()
    return text


def _request(url: str, key: str, body: dict | None, timeout: float) -> dict:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET")
    request.add_header("Content-Type", "application/json")
    request.add_header("User-Agent", "udemy-thai-learning-kit/1.3.0")
    if key:
        request.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            ct = response.headers.get("Content-Type", "")
            if "text/event-stream" in ct or raw.lstrip().startswith("data:"):
                pieces = []
                for line in raw.splitlines():
                    line = line.strip()
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[len("data:"):].strip()
                    if payload == "[DONE]":
                        continue
                    try:
                        chunk = json.loads(payload)
                        delta = chunk.get("choices", [{}])[0].get("delta", {})
                        if "content" in delta and delta["content"]:
                            pieces.append(delta["content"])
                    except json.JSONDecodeError:
                        continue
                return {"choices": [{"message": {"content": "".join(pieces)}}]}
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        if exc.code in (401, 403):
            raise RuntimeError(
                f"LLM ไม่รับ API key (HTTP {exc.code}) — ตรวจ UDTH_LLM_KEY หรือ OPENAI_API_KEY ใน .env ({detail})"
            ) from exc
        if exc.code in (429, 502, 503, 504, 530):  # rate limit or gateway/upstream down
            raise LlmUnavailable(f"LLM ไม่ตอบ (HTTP {exc.code}): {detail}") from exc
        raise RuntimeError(f"LLM ตอบ HTTP {exc.code}: {detail}") from exc
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
        raise LlmUnavailable(f"ติดต่อ LLM ไม่ได้: {exc}") from exc


def runner(
    url: str | None = None,
    key: str | None = None,
    model: str | None = None,
    fallback_model: str | None = None,
    timeout: float = TIMEOUT_SECONDS,
    log: Callable[[str], None] = print,
) -> Runner:
    """A chunk runner for translate_text: prompt in, answer text out."""
    base = normalize_url(url or get_url())
    key = key if key is not None else get_key()
    chosen = {"model": model or get_model() or None}
    chosen_fallback = fallback_model or get_fallback_model() or None
    lock = threading.Lock()

    def model_name() -> str:
        with lock:
            if not chosen["model"]:
                listed = _request(f"{base}/models", key, None, 30).get("data") or []
                if not listed:
                    raise RuntimeError("LLM ไม่ได้บอกชื่อโมเดล — ตั้ง UDTH_LLM_MODEL ใน .env")
                chosen["model"] = listed[0]["id"]
            return chosen["model"]

    def run(prompt: str, label: str) -> str:
        primary_model = model_name()
        try:
            reply = _request(
                f"{base}/chat/completions",
                key,
                {
                    "model": primary_model,
                    "messages": [{"role": "user", "content": prompt}],
                    # Subtitles want consistent terminology
                    "temperature": 0.2,
                },
                timeout,
            )
            content = reply["choices"][0]["message"]["content"] or ""
            if not content.strip() and chosen_fallback:
                raise LlmUnavailable("LLM ตอบกลับค่าว่าง")
            return clean_llm_response(content)
        except LlmUnavailable as exc:
            if chosen_fallback and chosen_fallback != primary_model:
                log(f"  {label} — โมเดลหลัก {primary_model} ขัดข้อง ({exc}) · สลับไปใช้โมเดลสำรอง {chosen_fallback} ทันที")
                reply = _request(
                    f"{base}/chat/completions",
                    key,
                    {
                        "model": chosen_fallback,
                        "messages": [{"role": "user", "content": prompt}],
                        "temperature": 0.2,
                    },
                    timeout,
                )
                content = reply["choices"][0]["message"]["content"] or ""
                return clean_llm_response(content)
            raise
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError(f"LLM ตอบไม่ตรงรูปแบบ OpenAI ที่ {label}") from exc

    return run


def with_fallback(
    primary: Runner, fallback: Runner, now: Callable[[], float] = time.monotonic, log=print
) -> Runner:
    """Use `primary`; when it is unreachable, answer this chunk with `fallback`
    and skip `primary` for RETRY_AFTER_SECONDS."""
    state = {"down_until": 0.0}
    lock = threading.Lock()

    def run(prompt: str, label: str) -> str:
        with lock:
            skip = now() < state["down_until"]
        if not skip:
            try:
                return primary(prompt, label)
            except LlmUnavailable as exc:
                with lock:
                    state["down_until"] = now() + RETRY_AFTER_SECONDS
                log(f"  {label} — {exc} · ใช้ตัวสำรองแทน (จะลอง LLM ใหม่ใน {RETRY_AFTER_SECONDS} วินาที)", flush=True)
        return fallback(prompt, label)

    return run
