"""Keep the example, installer, and server's API selection consistent."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

from tools import install
from udemy_th.env import parse
from udemy_th.cli import _serve_engine
from udemy_th.translate_agy import AgyNotFound


class InstallConfigTests(unittest.TestCase):
    def test_example_uses_lightweight_defaults_without_enabling_an_endpoint(self):
        values = parse((install.ROOT / ".env.example").read_text(encoding="utf-8"))
        self.assertEqual(values["UDTH_PRELOAD"], "off")
        self.assertEqual(values["UDTH_LLM_PARALLEL"], "3")
        self.assertEqual(values["UDTH_LLM_REVIEW"], "1")
        self.assertFalse(values.get("UDTH_LLM_URL"))
        self.assertFalse(values.get("UDTH_LLM_KEY"))

    def test_installer_accepts_api_without_agy_and_preserves_existing_env(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / ".env"
            contents = "UDTH_LLM_URL=http://localhost:20128/v1\nUDTH_LLM_KEY=private-test-value\n"
            config.write_text(contents, encoding="utf-8")
            output = io.StringIO()
            with patch.object(install, "ROOT", root), patch.object(install, "VENV_PYTHON", root / "python.exe"), patch.object(install, "run"), patch.object(install, "venv_python_check", return_value=Mock(returncode=0)), patch.object(install, "find_agy", return_value=None), patch.dict(os.environ, {}, clear=True), patch.object(sys, "argv", ["install.py", "--yes", "--no-gpu"]), contextlib.redirect_stdout(output):
                self.assertEqual(install.main(), 0)
            self.assertIn("OpenAI-compatible API", output.getvalue())
            self.assertNotIn("ยังไม่มีตัวแปล", output.getvalue())
            self.assertNotIn("private-test-value", output.getvalue())
            self.assertEqual(config.read_text(encoding="utf-8"), contents)

    def test_api_aliases_select_api_path_before_claude(self):
        for name in ("UDTH_LLM_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OLLAMA_HOST"):
            with self.subTest(name=name), patch.dict(os.environ, {name: "http://localhost:20128/v1", "ANTHROPIC_API_KEY": "test"}, clear=True), patch("udemy_th.translate_agy.find_agy", side_effect=AgyNotFound("not installed")):
                self.assertEqual(_serve_engine(None), "agy")


if __name__ == "__main__":
    unittest.main()
