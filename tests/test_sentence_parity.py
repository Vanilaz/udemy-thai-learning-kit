"""The server prefetches dub audio for whole sentences; the extension asks for
sentences built by extension/core/timeline.js. If the two group or join
differently, every prefetched clip is wasted GPU time, so they are compared
here on the same cues rather than against a hand-written expectation."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

from udemy_th import tts

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

CUES = [
    {"start": 0.0, "end": 1.5, "en": "So the function", "th": "ดังนั้นฟังก์ชันนี้"},
    {"start": 1.6, "end": 3.2, "en": "returns a string.", "th": "จะคืนค่าเป็นข้อความ"},
    {"start": 3.5, "end": 5.0, "en": "Untranslated line.", "th": ""},
    {"start": 5.2, "end": 7.0, "en": "Let us test it!", "th": " มาลองทดสอบกันเลย "},
    # A pause longer than the sentence gap splits without punctuation.
    {"start": 9.0, "end": 10.0, "en": "and then", "th": "แล้วก็"},
    {"start": 12.0, "end": 13.0, "en": "we save it", "th": "เราก็บันทึก"},
    # A run-on passage is cut at the maximum length.
    *[{"start": 14.0 + i * 3, "end": 16.5 + i * 3, "en": f"word {i}", "th": f"คำ {i}"} for i in range(8)],
    {"start": 40.0, "end": 41.0, "en": "", "th": "ไม่มีต้นฉบับ"},
    {"start": 41.0, "end": 42.0, "en": "Done (really).", "th": "เสร็จแล้วจริงๆ"},
]

SCRIPT = """
const {createTimeline} = require(process.argv[1]);
const rows = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const tl = createTimeline(rows.map(r => ({start: r.start, end: r.end, text: r.en})), {lang: 'EN'});
tl.applyTranslation(rows);
const seen = new Set(), out = [];
for (const s of tl.sentences) {
  if (s.final) { const text = s.final.split(/\\s+/).join(' ').trim(); if (!seen.has(text)) { seen.add(text); out.push(text); } }
}
process.stdout.write(JSON.stringify(out));
"""


@unittest.skipIf(NODE is None, "node is not installed")
class SentenceParityTests(unittest.TestCase):
    def test_server_and_extension_build_the_same_sentences(self):
        result = subprocess.run(
            [NODE, "-e", SCRIPT, str(ROOT / "extension" / "core" / "timeline.js")],
            input=json.dumps(CUES, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        from_extension = json.loads(result.stdout)
        from_server = [" ".join(s.split()) for s in tts.sentences_from_cues(CUES)]
        self.assertTrue(from_extension, "the fixture must produce sentences")
        self.assertEqual(from_server, from_extension)


if __name__ == "__main__":
    unittest.main()
