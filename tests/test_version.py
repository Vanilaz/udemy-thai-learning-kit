"""One version for the project, and every release is written down."""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import udemy_th

ROOT = Path(__file__).resolve().parent.parent


class VersionTests(unittest.TestCase):
    def test_server_reports_the_extension_version(self):
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(udemy_th.__version__, manifest["version"])

    def test_the_current_version_has_a_changelog_entry(self):
        changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
        released = re.findall(r"^## (\d+\.\d+\.\d+)\b", changelog, flags=re.M)
        self.assertTrue(released, "CHANGELOG.md lists no released version")
        self.assertEqual(released[0], udemy_th.__version__,
                         "bump extension/manifest.json and add a CHANGELOG.md entry together")


if __name__ == "__main__":
    unittest.main()
