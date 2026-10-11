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

    def synthesize(self, text: str, voice: str | None) -> dict:
        return self.engine_for(voice).synthesize(text, voice)

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
                    "voices": [
                        {"id": vid, "label": label} for vid, label in engine.voices.items()
                    ],
                }
            )
        return out
