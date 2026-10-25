"""Regression: repeated local loads must not crash with `wandb.__spec__ is None`."""

import importlib.util
import sys
import unittest
from unittest import mock

from udemy_th import flow_tts


class FlowTtsStubTests(unittest.TestCase):
    NAMES = ("wandb", "hydra", "hydra.utils", "omegaconf", "datasets", "cached_path")

    def setUp(self):
        self._saved = {n: sys.modules.get(n) for n in self.NAMES}

    def tearDown(self):
        for name, mod in self._saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod

    def test_module_available_tolerates_spec_none(self):
        import types

        sys.modules["wandb"] = types.ModuleType("wandb")  # __spec__ is None
        self.assertTrue(flow_tts._module_available("wandb"))

    def test_stub_has_spec_so_find_spec_does_not_raise(self):
        stub = flow_tts._make_stub("udth_fake_pkg_xyz", foo=1)
        sys.modules["udth_fake_pkg_xyz"] = stub
        try:
            self.assertIsNotNone(importlib.util.find_spec("udth_fake_pkg_xyz"))
            self.assertEqual(stub.foo, 1)
        finally:
            sys.modules.pop("udth_fake_pkg_xyz", None)

    def test_load_local_twice_raises_tts_error_not_value_error(self):
        engine = flow_tts.ThonburianTts(cache_dir=mock.MagicMock())
        with mock.patch.dict(sys.modules, {"flowtts": None, "flowtts.inference": None}):
            for _ in range(3):
                with self.assertRaises(flow_tts.TtsError):
                    engine._load_local()


if __name__ == "__main__":
    unittest.main()
