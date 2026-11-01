import json
from pathlib import Path
import tempfile
import unittest
from udemy_th.error_log import write, redact


class ErrorLogTests(unittest.TestCase):
    def test_redacts_secrets_and_drops_bodies(self):
        with tempfile.TemporaryDirectory() as tmp:
            write(Path(tmp), {"source": "speech", "message": "403 wss://user:pass@host/tts?key=hidden Bearer credential sk-private-value password=secret-value \"api_key\":\"opaque-secret\"",
                              "path": "/tts?key=private", "status": 403, "body": "lesson text", "key": "private"})
            text = (Path(tmp) / "logs/errors.jsonl").read_text(encoding="utf-8")
            for secret in ("user:pass", "hidden", "credential", "sk-private-value", "secret-value", "opaque-secret", "lesson text"):
                self.assertNotIn(secret, text)
            record = json.loads(text)
            self.assertEqual(record["status"], 403)
            self.assertEqual(record["path"], "/tts")

    def test_rotates_instead_of_growing_without_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "logs/errors.jsonl"
            path.parent.mkdir()
            path.write_bytes(b"x" * 1_000_000)
            write(Path(tmp), {"source": "test", "message": "new error"})
            self.assertTrue(path.with_name("errors.jsonl.1").exists())
            self.assertEqual(json.loads(path.read_text())["message"], "new error")


if __name__ == "__main__":
    unittest.main()
