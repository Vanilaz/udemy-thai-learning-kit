"""Background model loading for local voices (/tts/warmup)."""

from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path

from udemy_th.tts import TtsRegistry


class _SlowEngine:
    name = "slow"
    label = "slow"
    voices = {"slow:a": "a"}

    def __init__(self, fail: bool = False):
        self.release = threading.Event()
        self.calls = 0
        self.fail = fail
        self._model = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def warm(self) -> None:
        self.calls += 1
        self.release.wait(5)
        if self.fail:
            raise RuntimeError("no GPU")
        self._model = object()

    def status(self) -> dict:
        return {"configured": True}


class _HostedEngine:
    name = "hosted"
    label = "hosted"
    voices = {"hosted:a": "a"}

    def status(self) -> dict:
        return {"configured": True}


def _registry(*engines) -> TtsRegistry:
    TtsRegistry._build = staticmethod(lambda cache_dir: list(engines))
    return TtsRegistry(Path(tempfile.mkdtemp()))


def _wait_for(registry: TtsRegistry, name: str, state: str) -> dict:
    for _ in range(100):
        current = registry.warm_state(name)
        if current["state"] == state:
            return current
        time.sleep(0.02)
    raise AssertionError(f"{name} never reached {state}: {registry.warm_state(name)}")


class WarmupTests(unittest.TestCase):
    def setUp(self):
        self._build = TtsRegistry.__dict__["_build"]

    def tearDown(self):
        TtsRegistry._build = self._build

    def test_loads_in_background_once_then_reports_loaded(self):
        slow = _SlowEngine()
        registry = _registry(slow)
        self.assertEqual(registry.warm_state("slow")["state"], "idle")
        self.assertEqual(registry.warmup("slow")["state"], "loading")
        # Repeated polls while loading must not start a second load.
        self.assertEqual(registry.warmup("slow")["state"], "loading")
        slow.release.set()
        _wait_for(registry, "slow", "loaded")
        self.assertEqual(registry.warmup("slow")["state"], "loaded")
        self.assertEqual(slow.calls, 1)

    def test_failure_is_reported_and_can_be_retried(self):
        slow = _SlowEngine(fail=True)
        registry = _registry(slow)
        registry.warmup("slow")
        slow.release.set()
        failed = _wait_for(registry, "slow", "error")
        self.assertIn("no GPU", failed["error"])
        slow.fail = False
        self.assertEqual(registry.warmup("slow")["state"], "loading")
        _wait_for(registry, "slow", "loaded")

    def test_hosted_and_unknown_engines_never_block(self):
        registry = _registry(_HostedEngine())
        self.assertEqual(registry.warmup("hosted")["state"], "none")
        self.assertEqual(registry.warmup("nope")["state"], "error")


if __name__ == "__main__":
    unittest.main()
