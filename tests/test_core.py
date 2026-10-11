"""Smoke tests for the pure-Python core (no network, no agy, no Chrome).

Run:  python -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

from udemy_th import server
from udemy_th.build import _parse_subtitles, _parse_terms, _split_sections
from udemy_th.glossary import Glossary
from udemy_th.models import Lesson, Segment, Term
from udemy_th.parser import parse
from udemy_th.srt import to_srt


class ParserTests(unittest.TestCase):
    def test_srt(self):
        raw = "1\n00:00:01,000 --> 00:00:03,500\nHello world\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line\n"
        segs = parse(raw)
        self.assertEqual([s.text for s in segs], ["Hello world", "Second line"])
        self.assertAlmostEqual(segs[0].start, 1.0)
        self.assertAlmostEqual(segs[0].end, 3.5)
        self.assertEqual([s.id for s in segs], [1, 2])

    def test_vtt(self):
        raw = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n\n00:00:02.500 --> 00:00:04.000\nTwo\n"
        self.assertEqual([s.text for s in parse(raw)], ["One", "Two"])

    def test_udemy_panel(self):
        raw = "0:05\nFirst sentence here\n0:12\nSecond sentence\n1:03\nThird\n"
        segs = parse(raw)
        self.assertEqual(len(segs), 3)
        self.assertAlmostEqual(segs[0].start, 5.0)
        self.assertAlmostEqual(segs[2].start, 63.0)

    def test_plain_text_is_chunked_without_timing(self):
        raw = "This is a sentence. " * 40
        segs = parse(raw)
        self.assertGreater(len(segs), 1)
        self.assertTrue(all(not s.has_timing for s in segs))

    def test_empty(self):
        self.assertEqual(parse("   \n"), [])


class SrtTests(unittest.TestCase):
    def setUp(self):
        self.segs = [
            Segment(1, "Hello", 0.0, 2.0, "สวัสดี"),
            Segment(2, "World", 2.0, 4.25, None),
        ]

    def test_modes(self):
        dual = to_srt(self.segs, "dual")
        self.assertIn("Hello\nสวัสดี", dual)
        self.assertIn("00:00:02,000 --> 00:00:04,250", dual)
        self.assertIn("สวัสดี", to_srt(self.segs, "thai"))
        self.assertNotIn("สวัสดี", to_srt(self.segs, "en"))

    def test_untranslated_line_falls_back_to_english(self):
        self.assertIn("World", to_srt(self.segs, "thai"))

    def test_untimed_segments_still_make_valid_srt(self):
        out = to_srt([Segment(1, "no timing here at all", None, None)], "en")
        self.assertIn("-->", out)


class GlossaryTests(unittest.TestCase):
    def test_add_merge_and_relevance(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "g.json"
            g = Glossary(path)
            self.assertTrue(g.add(Term("closure", "โคลเชอร์", "x", True, ["a"])))
            self.assertFalse(g.add(Term("Closure", "โคลเชอร์", "x", True, ["b"])))
            self.assertEqual(g.terms["closure"].lessons, ["a", "b"])
            g.save()
            again = Glossary(path)
            self.assertEqual(list(again.terms), ["closure"])
            hits = again.relevant_to("A CLOSURE remembers things")
            self.assertEqual([t.term for t in hits], ["closure"])
            self.assertIn("closure", again.as_prompt_block(hits))
            self.assertIn("closure", again.to_markdown("t"))


class LessonRoundTrip(unittest.TestCase):
    def test_save_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            lesson = Lesson("s", "t", "c", [Segment(1, "a", 0.0, 1.0, "ก")], "sum", ["k"])
            path = Path(tmp) / "l.json"
            lesson.save(path)
            back = Lesson.load(path)
            self.assertEqual(back.segments[0].thai, "ก")
            self.assertEqual(back.translated_count, 1)


class BuildParsingTests(unittest.TestCase):
    ANSWER = (
        "## SUBTITLES\n[[1]] หนึ่ง\n[[2]] สอง\n\n## SUMMARY\nสรุป\n\n## TERMS\n"
        "closure | โคลเชอร์ | keep | ฟังก์ชันที่จำค่า\n"
    )

    def test_sections(self):
        sections = _split_sections(self.ANSWER)
        self.assertIn("SUBTITLES", sections)
        self.assertIn("TERMS", sections)

    def test_subtitles_and_terms(self):
        sections = _split_sections(self.ANSWER)
        subs = _parse_subtitles(sections["SUBTITLES"])
        self.assertEqual(subs[1], "หนึ่ง")
        self.assertEqual(subs[2], "สอง")
        terms = _parse_terms(sections["TERMS"], "lesson-1")
        self.assertEqual(terms[0].term, "closure")
        self.assertTrue(terms[0].keep_english)


class _FakeTts:
    def catalogue(self):
        return []


class ServerTests(unittest.TestCase):
    """Boot the real HTTP handler on a free port and poke its edges."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        tmp = Path(cls.tmp.name)
        handler = server._Handler
        handler.cache_dir = tmp / "cache"
        handler.cache_dir.mkdir()
        handler.glossary_path = tmp / "g.json"
        handler.engine = "agy"
        handler.effort = "low"
        handler.tts = _FakeTts()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    def call(self, path, body=None, origin=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data)
        # The extension always posts JSON; the server refuses anything else.
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if origin:
            req.add_header("Origin", origin)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    def test_health(self):
        status, body = self.call("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_unknown_route(self):
        self.assertEqual(self.call("/nope")[0], 404)
        self.assertEqual(self.call("/nope", {"a": 1})[0], 404)

    def test_translate_requires_cues(self):
        status, body = self.call("/translate", {"cues": []})
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_cache_hit_returns_cues_without_running_a_job(self):
        # The shape the extension sends: every cue carries start, end and text.
        cues = [{"start": 0, "end": 1, "text": "hello"}]
        key = server._cache_key("c", "lec\x00subtitle", cues)
        stored = [{"start": 0, "end": 1, "en": "hello", "th": "สวัสดี"}]
        (server._Handler.cache_dir / f"{key}.json").write_text(
            json.dumps(stored, ensure_ascii=False), encoding="utf-8"
        )
        status, body = self.call("/translate", {"course": "c", "lecture": "lec", "cues": cues})
        self.assertEqual(status, 200)
        self.assertTrue(body["cached"])
        self.assertEqual(body["cues"][0]["th"], "สวัสดี")

    def test_cache_key_is_stable_and_sensitive(self):
        a = server._cache_key("c", "t", [{"start": 0, "text": "x"}])
        self.assertEqual(a, server._cache_key("c", "t", [{"start": 0, "text": "x"}]))
        self.assertNotEqual(a, server._cache_key("c", "t", [{"start": 0, "text": "y"}]))

    def test_web_pages_cannot_drive_the_server(self):
        status, _ = self.call("/health", origin="https://evil.example")
        self.assertEqual(status, 403)
        status, _ = self.call("/translate", {"cues": [{"text": "x"}]}, origin="https://evil.example")
        self.assertEqual(status, 403)

    def test_extension_origin_is_allowed_and_echoed(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/health")
        # A real extension id: 32 letters a-p, the only shape Chrome issues.
        req.add_header("Origin", "chrome-extension://abcdefghijklmnopabcdefghijklmnop")
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], "chrome-extension://abcdefghijklmnopabcdefghijklmnop")

    def test_dns_rebinding_host_is_refused(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/health")
        req.add_header("Host", "attacker.example:8765")
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 403)

    def test_malformed_json(self):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/translate", data=b"{not json", method="POST",
            headers={"Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 400)



class TidyTests(unittest.TestCase):
    def test_tidy_merges_variants_and_drops_ui_words(self):
        with tempfile.TemporaryDirectory() as tmp:
            g = Glossary(Path(tmp) / "g.json")
            g.add(Term("Array.from", "a", "short", True, ["l1"]))
            g.add(Term("Array.from()", "b", "a much longer explanation", True, ["l2"]))
            g.add(Term("BOM (Browser Object Model)", "c", "long long long long", True, ["l3"]))
            g.add(Term("BOM", "d", "x", True, ["l4"]))
            g.add(Term("speed", "ความเร็ววิดีโอ", "player", True, ["l5"]))
            merged, dropped = g.tidy()
            self.assertEqual((merged, dropped), (2, 1))
            self.assertEqual(sorted(t.term for t in g.terms.values()), ["Array.from", "BOM"])
            array_from = g.terms["array.from"]
            self.assertEqual(array_from.explanation, "a much longer explanation")
            self.assertEqual(sorted(array_from.lessons), ["l1", "l2"])

if __name__ == "__main__":
    unittest.main()
