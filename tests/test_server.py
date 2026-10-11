"""Exercise the real HTTP handler and job lifecycle without calling providers."""
import contextlib
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from udemy_th import server as s
from udemy_th.google_tts import TtsError


class FakeTts:
    def catalogue(self):
        return []

    def synthesize(self, text, voice, source_lang=None):
        raise TtsError("Unavailable test engine")


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hongrian-test-")
        self.root = Path(self.tmp.name)
        s._restore_jobs(self.root, self.root / "glossary.json")
        root = self.root

        class Handler(s._Handler):
            cache_dir = root
            glossary_path = root / "glossary.json"
            engine = "test"
            effort = "low"
            tts = FakeTts()

        self.httpd = s._Server(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.cues = [{"start": 0, "end": 2, "text": "First."}, {"start": 2, "end": 4, "text": "Second."}]

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        s._store_path = None
        s._jobs.clear()
        s._job_args.clear()
        s._queue.clear()
        self.tmp.cleanup()

    def request(self, method, path, payload=None, headers=None, raw=None):
        body = raw if raw is not None else json.dumps(payload) if payload is not None else None
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=3)
        try:
            conn.request(method, path, body, {"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            data = response.read()
            return response.status, json.loads(data) if data else {}, dict(response.getheaders())
        finally:
            conn.close()

    def enqueue(self, **extra):
        status, data, _ = self.request("POST", "/translate", {"title": "Demo", "course": "test", "lecture": "1", "cues": self.cues, **extra})
        self.assertEqual(status, 202)
        return data["job"]

    def run_job(self, key, answers):
        with s._cv:
            s._queue.remove(key)
        with patch.object(s, "_translate", side_effect=answers) as translate, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            s._run_job(key, *s._job_args[key])
        return translate

    def test_valid_input_and_missing_job(self):
        self.assertEqual(self.request("GET", "/job/missing")[0], 404)
        key = self.enqueue()
        self.assertEqual(self.request("GET", f"/job/{key}")[1]["status"], "queued")

    def test_invalid_payloads_return_json_400(self):
        for payload in ([], None, "text", {"cues": []}, {"cues": [1]}, {"cues": self.cues, "title": 1}):
            with self.subTest(payload=payload):
                status, data, _ = self.request("POST", "/translate", raw=json.dumps(payload))
                self.assertEqual(status, 400)
                self.assertIn("error", data)

    def test_invalid_time_and_flags(self):
        for start, end in ((-1, 2), (3, 2), (0, float("nan")), (True, 2), (0, "2")):
            status, _, _ = self.request("POST", "/translate", {"cues": [{"start": start, "end": end, "text": "Text"}]})
            self.assertEqual(status, 400)
        self.assertEqual(self.request("POST", "/translate", {"cues": self.cues, "force": "false"})[0], 400)

    def test_bad_length_and_bad_json(self):
        for length in ("abc", "0", str(s.MAX_BODY_BYTES + 1)):
            self.assertEqual(self.request("POST", "/translate", raw="", headers={"Content-Length": length})[0], 400)
        self.assertEqual(self.request("POST", "/translate", raw="{")[0], 400)
        self.assertEqual(self.request("POST", "/translate", raw="{}", headers={"Content-Type": "text/plain"})[0], 415)

    def test_viewer_focus_is_recorded_for_a_job(self):
        key = "a" * 20
        self.assertEqual(self.request("POST", f"/job/{key}/focus", {"time": 412.5})[0], 200)
        self.assertEqual(s._focus_of(key)(), 412.5)
        for bad in ({"time": "soon"}, {"time": -1}, {}):
            self.assertEqual(self.request("POST", f"/job/{key}/focus", bad)[0], 400)

    def test_origin_and_host_guards(self):
        for origin in ("https://untrusted.invalid", "null", "https://www.youtube.com"):
            self.assertEqual(self.request("OPTIONS", "/translate", headers={"Origin": origin})[0], 403)
            self.assertEqual(self.request("POST", "/translate", {"cues": self.cues}, headers={"Origin": origin})[0], 403)
        origin = "chrome-extension://" + "a" * 32
        code, _, headers = self.request("OPTIONS", "/translate", headers={"Origin": origin})
        self.assertEqual(code, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(self.request("GET", "/health", headers={"Host": "untrusted.invalid"})[0], 403)

    def test_audio_path_escape_and_tts_failure(self):
        self.assertEqual(self.request("GET", "/audio/..%2Fsecret.mp3")[0], 404)
        self.assertEqual(self.request("POST", "/tts", {"text": "Test", "voice": "none"})[0], 400)

    def test_duplicate_queue_and_priority(self):
        key = self.enqueue(batch=True)
        self.assertEqual(self.enqueue(), key)
        self.assertEqual(s._queue, [key])
        self.assertEqual(s._jobs[key]["priority"], s.PRIORITY_NOW)

    def test_cancel_and_retry_survive_restart(self):
        key = self.enqueue()
        self.assertEqual(self.request("POST", f"/job/{key}/cancel", {})[1]["status"], "cancelled")
        self.assertEqual(s._queue, [])
        s._restore_jobs(self.root, self.root / "glossary.json")
        self.assertEqual(s._jobs[key]["status"], "cancelled")
        self.assertEqual(self.request("POST", f"/job/{key}/retry", {})[1]["status"], "queued")
        self.assertEqual(s._queue, [key])
        self.assertEqual(self.request("POST", f"/job/{key}/retry", {})[0], 409)

    def test_running_job_returns_to_queue_after_restart(self):
        key = self.enqueue()
        s._queue.remove(key)
        s._set_job(key, status="running")
        s._restore_jobs(self.root, self.root / "glossary.json")
        self.assertEqual(s._queue, [key])
        self.assertTrue(s._jobs[key]["resumed"])

    def test_repair_only_missing_lines_and_cache_complete_result(self):
        key = self.enqueue()
        translate = self.run_job(key, [["## SUBTITLES\n[[1]] One"], ["## SUBTITLES\n[[2]] Two"]])
        self.assertEqual([segment.id for segment in translate.call_args_list[1].args[0].segments], [2])
        self.assertEqual(s._jobs[key]["status"], "done")
        status, data, _ = self.request("POST", "/translate", {"course": "test", "lecture": "1", "cues": self.cues})
        self.assertEqual(status, 200)
        self.assertTrue(data["cached"])
        self.assertEqual([c["th"] for c in data["cues"]], ["One", "Two"])

    def test_incomplete_or_invalid_translation_is_not_success(self):
        for answer in ("## SUBTITLES\n[[1]] One", "invalid"):
            key = self.enqueue(force=True)
            self.run_job(key, [[answer], [answer]])
            self.assertEqual(s._jobs[key]["status"], "error")
            self.assertFalse((self.root / f"{key}.json").exists())

    def test_cancel_during_translation_never_writes_success(self):
        key = self.enqueue()
        def translate(*args):
            self.assertEqual(self.request("POST", f"/job/{key}/cancel", {})[1]["status"], "cancelling")
            return ["## SUBTITLES\n[[1]] One\n[[2]] Two"]
        self.run_job(key, translate)
        self.assertEqual(s._jobs[key]["status"], "cancelled")
        self.assertFalse((self.root / f"{key}.json").exists())

    def test_old_incomplete_cache_is_not_reused(self):
        key = s._cache_key("test", "1\0subtitle", self.cues)
        (self.root / f"{key}.json").write_text('[{"th":"One"}]')
        self.assertEqual(self.enqueue(), key)

    def test_done_job_can_be_polled_after_restart(self):
        key = self.enqueue()
        self.run_job(key, [["## SUBTITLES\n[[1]] One\n[[2]] Two"]])
        s._restore_jobs(self.root, self.root / "glossary.json")
        result = self.request("GET", f"/job/{key}")[1]
        self.assertEqual(result["status"], "done")
        self.assertEqual(len(result["cues"]), 2)

    def test_corrupt_journal_is_preserved(self):
        journal = self.root / "jobs-state.json"
        journal.write_text("invalid")
        with self.assertRaises(RuntimeError):
            s._restore_jobs(self.root, self.root / "glossary.json")
        self.assertEqual(journal.read_text(), "invalid")


if __name__ == "__main__":
    unittest.main()
