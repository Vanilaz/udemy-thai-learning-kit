"""Registry of speech engines, and the routing between them.

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

import threading
from pathlib import Path

from .edge_tts_engine import EdgeTts
from .google_tts import GoogleTts, TtsError
from .omnivoice_tts import OmniVoiceTts
from .seamless_tts import SeamlessTts


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

    def local_engines(self) -> list[str]:
        """Engines that run a model on this machine (and so need loading)."""
        return [name for name, engine in self._engines.items() if hasattr(engine, "warm")]

    def preload(self, setting: str) -> None:
        """Load local voice models in the background as the server starts.

        The weights are already on disk; what costs 10-60s is moving them onto
        the GPU, once per server process. Doing it at startup means the first
        lecture never waits. `setting` (UDTH_PRELOAD): "auto" loads every local
        engine when a CUDA GPU is present, "off" loads nothing, or a comma list
        of engine names. Never blocks: the CUDA check alone imports torch.
        """
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
        # first, then the one that needs an account, then the one that needs
        # a GPU.
        return [
            EdgeTts(cache_dir),
            GoogleTts(cache_dir),
            SeamlessTts(cache_dir),
            OmniVoiceTts(cache_dir),
        ]

    def engine_for(self, voice: str | None):
        """Which engine owns this voice. The voice id is the routing key, so
        the extension never sends an engine name that could contradict it."""
        for engine in self._engines.values():
            if voice in engine.voices:
                return engine
        raise TtsError(f"ไม่รู้จักเสียง {voice!r}")

    def synthesize(self, text: str, voice: str | None, source_lang: str | None = None) -> dict:
        engine = self.engine_for(voice)
        # Thai is what every engine speaks; anything else must be translated on
        # the way, which only an engine marked `translates` can do. Refusing is
        # better than reading Spanish aloud with a Thai voice.
        if source_lang and source_lang.lower().replace("_", "-") not in ("th", "th-th", "tha"):
            if not getattr(engine, "translates", False):
                raise TtsError(f"{engine.label} แปลจากภาษาต้นฉบับเองไม่ได้ — ต้องรอคำแปลไทย")
            return engine.synthesize(text, voice, source_lang)
        return engine.synthesize(text, voice)

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
