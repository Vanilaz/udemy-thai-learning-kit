"""Registry of speech engines, routing, A100 auto-fallback, and parallel prefetch.

Adding an engine means writing one class and adding one line to `_build`.
Nothing else changes: the server asks the registry, and the extension asks the
server, so a new engine turns up in the in-player voice list on its own without
the extension being touched at all.

An engine needs four things:

    name      short id, unique
    label     what the user sees in the picker
    voices    {voice_id: human label}
    status()  {"configured": bool, "error": str}  — never raises
    synthesize(text, voice) -> {"file": str, "cached": bool}

Engines are constructed eagerly but must not do real work until used: they are
all built at startup on machines that have none of their dependencies
installed, so imports belong inside methods, not at module level.
"""

from __future__ import annotations

import contextlib
import os
import time
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import a100_voice
from .edge_tts_engine import EdgeTts
from .flow_tts import OpenJaiTts, ThonburianTts
from .thai_numbers import spell_numbers
from .google_tts import GoogleTts, TtsError
from .omnivoice_tts import OmniVoiceTts
from .seamless_tts import SeamlessTts

# Clips made ahead in the background at once (see prefetch_cues_async). One:
# the GPU makes one clip at a time, so a second only lengthens the queue a
# live request waits in.
PREFETCH_WORKERS = max(1, int(os.environ.get("UDTH_PREFETCH_WORKERS", "1")))
# Background clips wait while the player is asking for one, and this long
# after: a seek asks for several lines in a row.
LIVE_QUIET_SECONDS = 2.0

# Matches extension/core/timeline.js sentence grouping 1-to-1 so server-side
# parallel prefetch warms the exact sentence strings the browser will request.
SENTENCE_GAP_SECONDS = 1.2
MAX_SENTENCE_SECONDS = 14.0
_ENDS_SENTENCE = re.compile(r'[.!?。！？][")\'\]]?\s*$')


def sentences_from_cues(cues: list[dict]) -> list[str]:
    """Group translated cue rows (`{start, end, en, th}`) into whole Thai sentences
    using the exact same boundary rules as `extension/core/timeline.js`."""
    groups: list[dict] = []
    current: dict | None = None
    for cue in cues:
        en = (cue.get("en") or cue.get("text") or "").strip()
        if not en:
            continue
        start = float(cue.get("start") or 0.0)
        end = float(cue.get("end") or 0.0)
        breaks = current is not None and (
            start - current["end"] > SENTENCE_GAP_SECONDS
            or end - current["start"] > MAX_SENTENCE_SECONDS
        )
        if breaks and current is not None:
            groups.append(current)
            current = None
        th = (cue.get("th") or "").strip()
        if current is not None:
            current["end"] = end
            current["parts"].append(th)
        else:
            current = {"start": start, "end": end, "parts": [th]}
        if _ENDS_SENTENCE.search(en):
            groups.append(current)
            current = None
    if current is not None:
        groups.append(current)

    out: list[str] = []
    seen: set[str] = set()
    for group in groups:
        parts = group["parts"]
        if parts and all(parts):
            sentence = " ".join(parts).strip()
            if sentence and sentence not in seen:
                seen.add(sentence)
                out.append(sentence)
    return out


class TtsRegistry:
    def __init__(self, cache_dir: Path):
        self._engines: dict[str, object] = {}
        for engine in self._build(cache_dir):
            self._engines[engine.name] = engine
        # Local models take up to a minute to load on first use. The extension
        # asks for that to happen up front and holds the video until it is
        # done, instead of the first sentences going silent while it loads.
        self._warm_lock = threading.Lock()
        self._warm_errors: dict[str, str] = {}
        self._warming: set[str] = set()
        # Background prefetch: one long-lived pool, a memory of what it was
        # already asked for, and the voice the player last used.
        self._prefetch_pool = None
        self._prefetch_lock = threading.Lock()
        self._prefetch_seen: set[tuple[str, str]] = set()
        self.last_voice: str | None = None
        self._live = 0
        self._live_ended = 0.0

    def local_engines(self) -> list[str]:
        """Engines that run a model on this machine (and so need loading)."""
        if a100_voice.configured():
            return []
        return [name for name, engine in self._engines.items() if hasattr(engine, "warm")]

    def preload(self, setting: str) -> None:
        """Load local voice models in the background as the server starts.

        The weights are already on disk; what costs 10-60s is moving them onto
        the GPU, once per server process. Doing it at startup means the first
        lecture never waits. `setting` (UDTH_PRELOAD): "auto" loads every local
        engine when a CUDA GPU is present, "off" loads nothing, or a comma list
        of engine names. Never blocks: the CUDA check alone imports torch.
        """
        if a100_voice.configured():
            return
        setting = (setting or "auto").strip().lower()
        if setting in ("off", "none", "0", "no", "false"):
            return
        wanted = (
            self.local_engines()
            if setting == "auto"
            else [n.strip() for n in setting.split(",") if n.strip() in self._engines]
        )
        if not wanted:
            return

        def run() -> None:
            if setting == "auto":
                try:
                    import torch

                    if not torch.cuda.is_available():
                        print("  ข้ามการโหลดโมเดลเสียงล่วงหน้า — ไม่พบการ์ดจอ CUDA", flush=True)
                        return
                except Exception:
                    return  # GPU voices not installed; nothing to preload
            print(f"  กำลังโหลดโมเดลเสียงล่วงหน้า: {', '.join(wanted)} (เบื้องหลัง)", flush=True)
            for name in wanted:
                self.warmup(name)

        threading.Thread(target=run, daemon=True, name="udth-preload").start()

    def warm_state(self, name: str) -> dict:
        """{"state": none|loading|loaded|error, "error": str} for one engine.

        "none" means the engine has nothing to load (hosted voices), so the
        caller can go ahead immediately.
        """
        engine = self._engines.get(name)
        if engine is None:
            return {"state": "error", "error": f"ไม่รู้จักเครื่องมือเสียง {name!r}"}
        if not hasattr(engine, "warm"):
            return {"state": "none", "error": ""}
        with self._warm_lock:
            if name in self._warming:
                return {"state": "loading", "error": ""}
            if name in self._warm_errors:
                return {"state": "error", "error": self._warm_errors[name]}
        return {"state": "loaded" if engine.loaded else "idle", "error": ""}

    def warmup(self, name: str) -> dict:
        """Start loading an engine's model in the background; never blocks."""
        current = self.warm_state(name)
        if name not in self._engines or current["state"] not in ("idle", "error"):
            return current
        engine = self._engines[name]
        with self._warm_lock:
            if name in self._warming:
                return {"state": "loading", "error": ""}
            self._warming.add(name)
            self._warm_errors.pop(name, None)

        def load() -> None:
            try:
                engine.warm()
            except Exception as exc:  # reported to the extension, not raised
                with self._warm_lock:
                    self._warm_errors[name] = str(exc)
            finally:
                with self._warm_lock:
                    self._warming.discard(name)

        threading.Thread(target=load, daemon=True, name=f"udth-warm-{name}").start()
        return {"state": "loading", "error": ""}

    @staticmethod
    def _build(cache_dir: Path) -> list:
        # Order is the order the picker shows them in: free and zero-setup
        # first, then Google Cloud, then local/A100 GPU models.
        return [
            EdgeTts(cache_dir),
            GoogleTts(cache_dir),
            SeamlessTts(cache_dir),
            OmniVoiceTts(cache_dir),
            ThonburianTts(cache_dir),
            OpenJaiTts(cache_dir),
        ]

    def engine_for(self, voice: str | None):
        """Which engine owns this voice. The voice id is the routing key, so
        the extension never sends an engine name that could contradict it."""
        for engine in self._engines.values():
            if voice in engine.voices:
                return engine
        raise TtsError(f"ไม่รู้จักเสียง {voice!r}")

    def _fallback_voice(self, voice: str | None) -> str:
        override = (os.environ.get("UDTH_A100_FALLBACK_VOICE") or "").strip()
        if override and override in self._engines["edge"].voices:
            return override
        if voice and "female" in voice.lower():
            return "th-TH-PremwadeeNeural"
        return "th-TH-NiwatNeural"

    def synthesize(self, text: str, voice: str | None, source_lang: str | None = None) -> dict:
        engine = self.engine_for(voice)
        is_non_thai = bool(
            source_lang and source_lang.lower().replace("_", "-") not in ("th", "th-th", "tha")
        )
        # Thai is what every engine speaks; anything else must be translated on
        # the way, which only an engine marked `translates` can do. Refusing is
        # better than reading Spanish aloud with a Thai voice.
        if is_non_thai:
            if not getattr(engine, "translates", False):
                raise TtsError(f"{engine.label} แปลจากภาษาต้นฉบับเองไม่ได้ — ต้องรอคำแปลไทย")
            try:
                return engine.synthesize(text, voice, source_lang)
            except a100_voice.A100Unavailable as exc:
                raise TtsError(
                    "เซิร์ฟเวอร์เสียง A100 หลุดการเชื่อมต่อ จึงแปลเสียงสดไม่ได้ชั่วคราว (กำลังรอคำแปลซับจาก agy)"
                ) from exc

        # Every Thai voice misreads bare digits ("2025" came back as "2005"
        # from all of them); written as words they read them right.
        text = spell_numbers(text)
        try:
            return engine.synthesize(text, voice)
        except a100_voice.A100Unavailable:
            fallback_voice = self._fallback_voice(voice)
            edge = self._engines["edge"]
            res = edge.synthesize(text, fallback_voice)
            return {**res, "fallback": fallback_voice}

    def prefetch_texts(
        self,
        texts: list[str],
        voice: str,
        parallel: int | None = None,
    ) -> list[dict]:
        """Synthesize multiple Thai sentences in parallel (e.g. on Colab A100)."""
        clean = [" ".join((t or "").split()) for t in texts]
        clean = [t for t in clean if t]
        if not clean:
            return []
        workers = min(len(clean), max(1, parallel or a100_voice.PREFETCH_PARALLEL))
        if workers == 1:
            return [self.synthesize(t, voice) for t in clean]
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="udth-tts-batch") as pool:
            futures = [pool.submit(self.synthesize, t, voice) for t in clean]
            return [f.result() for f in futures]

    @contextlib.contextmanager
    def live(self):
        """Mark a request the player is waiting on; background clips yield to it.

        Measured on Udemy over the A100: a seek's first line came 26s late and
        was dropped, because it queued behind clips made ahead that nobody
        was listening to yet.
        """
        with self._prefetch_lock:
            self._live += 1
        try:
            yield
        finally:
            with self._prefetch_lock:
                self._live -= 1
                self._live_ended = time.monotonic()

    def _wait_for_quiet(self, sleep=time.sleep, now=time.monotonic, limit: float = 120.0) -> None:
        started = now()
        while now() - started < limit:
            with self._prefetch_lock:
                busy = self._live > 0 or now() - self._live_ended < LIVE_QUIET_SECONDS
            if not busy:
                return
            sleep(0.2)

    def prefetch_cues_async(self, cues: list[dict], voice: str | None = None) -> None:
        """Queue the dub audio of every finished sentence, as each translated
        chunk comes in, so seeking anywhere finds it ready.

        The voice is the one the player last asked for (or UDTH_PREFETCH_VOICE):
        audio in another voice would never be played. Nothing is queued before
        the player has dubbed anything, so a lecture watched without dubbing
        costs no GPU time.

        Each sentence is queued once, however many partial results repeat it,
        and at most PREFETCH_WORKERS at a time: the GPU on the other end makes
        one clip at a time, and a live request from the player must never
        wait behind a long queue of clips nobody is listening to yet.
        """
        target_voice = (
            voice or (os.environ.get("UDTH_PREFETCH_VOICE") or "").strip() or self.last_voice or ""
        )
        if not target_voice:
            return
        try:
            self.engine_for(target_voice)
        except TtsError:
            return
        fresh = []
        with self._prefetch_lock:
            for sentence in sentences_from_cues(cues):
                key = (target_voice, sentence)
                if key not in self._prefetch_seen:
                    self._prefetch_seen.add(key)
                    fresh.append(sentence)
            if not fresh:
                return
            if self._prefetch_pool is None:
                self._prefetch_pool = ThreadPoolExecutor(
                    max_workers=PREFETCH_WORKERS, thread_name_prefix="udth-tts-prefetch"
                )
            pool = self._prefetch_pool

        def one(sentence: str) -> None:
            a100_voice.priority.set(a100_voice.BACKGROUND)
            try:
                self._wait_for_quiet()
                self.synthesize(sentence, target_voice)
            except Exception:
                # Best effort; forget it so a later partial can try again.
                with self._prefetch_lock:
                    self._prefetch_seen.discard((target_voice, sentence))

        for sentence in fresh:
            pool.submit(one, sentence)

    def catalogue(self) -> list[dict]:
        """Every engine with its voices and whether it is usable right now.

        Reported even when unusable, with the reason attached — "Google needs
        credentials" is worth showing in the picker, because hiding it just
        makes the option look like it does not exist.
        """
        out = []
        for engine in self._engines.values():
            try:
                status = engine.status()
            except Exception as exc:  # a broken engine must not hide the rest
                status = {"configured": False, "error": str(exc)}
            out.append(
                {
                    "name": engine.name,
                    "label": engine.label,
                    "ready": bool(status.get("configured")),
                    "error": status.get("error", ""),
                    "unlimited": bool(status.get("unlimited")),
                    "used": status.get("used"),
                    "limit": status.get("limit"),
                    # Can speak Thai straight from the original-language text.
                    "translates": bool(getattr(engine, "translates", False)),
                    "voices": [
                        {"id": vid, "label": label} for vid, label in engine.voices.items()
                    ],
                }
            )
        return out
