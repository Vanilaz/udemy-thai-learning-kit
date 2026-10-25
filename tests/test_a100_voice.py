"""Tests for Colab A100 Voice Server, ThonburianTTS/OpenJaiTTS, batch prefetch, and ASR."""

from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch

from udemy_th import a100_voice, asr, flow_tts, omnivoice_tts, seamless_tts, tts
from udemy_th.google_tts import TtsError


class FakeA100Server(BaseHTTPRequestHandler):
    """Simulates colab/hongrian_voice_a100.ipynb (/v1/health, /v1/tts, /v1/asr)."""

    key = "a100-secret"
    requests: list[dict] = []
    known_refs: set[str] = set()

    def log_message(self, *args):
        pass

    def _reply(self, code: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        if self.headers.get("Authorization") != f"Bearer {self.key}":
            self._reply(401, {"error": "bad key"})
            return False
        return True

    def do_GET(self):
        if not self._authorised():
            return
        if self.path == "/v1/health":
            self._reply(
                200,
                {
                    "ok": True,
                    "gpu": "NVIDIA A100-SXM4-40GB",
                    "models": {
                        "thonburian": "megaF5",
                        "openjai": "v1.0",
                        "omnivoice": "omnivoice-thai",
                        "seamless": "v2-large",
                    },
                },
            )
            return
        self._reply(404, {"error": "not found"})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        if not self._authorised():
            return
        body = json.loads(raw.decode("utf-8"))
        FakeA100Server.requests.append({"path": self.path, **body})

        if self.path == "/v1/tts":
            ref_id = body.get("ref_id")
            if ref_id:
                if body.get("ref_audio_b64"):
                    FakeA100Server.known_refs.add(ref_id)
                elif ref_id not in FakeA100Server.known_refs:
                    self._reply(428, {"error": "missing_ref"})
                    return
            spoken = ""
            if body.get("engine") == "seamless" and body.get("source_lang") not in (None, "tha"):
                spoken = f"แปลด่วน:{body['text']}"
            ref_text = "ถอดเสียงตัวอย่างสำเร็จ" if ref_id and not body.get("ref_text") else None
            self._reply(
                200,
                {
                    "audio_b64": base64.b64encode(b"RIFF-A100-WAV").decode("ascii"),
                    "text": spoken,
                    "ref_text": ref_text,
                },
            )
            return

        if self.path == "/v1/asr":
            self._reply(
                200,
                {
                    "text": "Hello and welcome to the course.",
                    "lang": body.get("lang") or "en",
                    "cues": [
                        {"start": 0.0, "end": 2.4, "text": "Hello and welcome"},
                        {"start": 2.4, "end": 4.8, "text": "to the course."},
                    ],
                },
            )
            return

        self._reply(404, {"error": "not found"})


class A100VoiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeA100Server)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        FakeA100Server.requests = []
        FakeA100Server.known_refs = set()
        a100_voice.reset_circuit()

    def test_thonburian_and_openjai_synthesize_on_a100_and_cache_locally(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "a100-secret"}
        ):
            reg = tts.TtsRegistry(Path(tmp))
            first = reg.synthesize("สวัสดีครับ วันนี้เรียน HTML", "thonburian:default")
            second = reg.synthesize("สวัสดีครับ วันนี้เรียน HTML", "thonburian:default")
            openjai = reg.synthesize("เปิดไฟล์ index.html", "openjai:default")

            self.assertFalse(first["cached"])
            self.assertTrue(second["cached"])
            self.assertFalse(openjai["cached"])
            self.assertEqual(len(FakeA100Server.requests), 2, "second call served from local disk cache")
            self.assertEqual(FakeA100Server.requests[0]["engine"], "thonburian")
            self.assertEqual(FakeA100Server.requests[1]["engine"], "openjai")

    def test_voice_cloning_uploads_reference_once_and_reuploads_if_a100_restarts(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "a100-secret"}
        ):
            clip = Path(tmp) / "instructor.wav"
            clip.write_bytes(b"RIFF-SAMPLE-VOICE")
            engine = flow_tts.ThonburianTts(Path(tmp))
            engine.reference = str(clip)

            engine.synthesize("ประโยคที่หนึ่ง", "thonburian:clone")
            engine.synthesize("ประโยคที่สอง", "thonburian:clone")
            self.assertIn("ref_audio_b64", FakeA100Server.requests[0])
            self.assertNotIn("ref_audio_b64", FakeA100Server.requests[1], "second sentence reuses uploaded ref")

            # Simulate Colab runtime restart clearing in-memory refs (returns HTTP 428)
            FakeA100Server.known_refs.clear()
            engine.synthesize("ประโยคที่สาม", "thonburian:clone")
            self.assertEqual(len(FakeA100Server.requests), 4, "428 triggers transparent re-upload")
            self.assertIn("ref_audio_b64", FakeA100Server.requests[-1])

    def test_seamless_t2st_on_a100_returns_provisional_thai_text(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "a100-secret"}
        ):
            reg = tts.TtsRegistry(Path(tmp))
            res = reg.synthesize("Hello world", "seamless:th", source_lang="en")
            self.assertEqual(res.get("text"), "แปลด่วน:Hello world")
            cached = reg.synthesize("Hello world", "seamless:th", source_lang="en")
            self.assertTrue(cached["cached"])
            self.assertEqual(cached.get("text"), "แปลด่วน:Hello world")

    def test_wrong_api_key_raises_immediately_without_falling_back(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "wrong-key"}
        ):
            reg = tts.TtsRegistry(Path(tmp))
            with self.assertRaises(TtsError) as caught:
                reg.synthesize("สวัสดี", "thonburian:default")
            self.assertIn("UDTH_A100_KEY", str(caught.exception))

    def test_unreachable_a100_trips_circuit_breaker_and_falls_back_to_edge(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": "http://127.0.0.1:9", "UDTH_A100_KEY": "a100-secret"}
        ):
            reg = tts.TtsRegistry(Path(tmp))
            edge = reg._engines["edge"]
            edge_calls = []

            def fake_edge_synth(text, voice=None):
                edge_calls.append((text, voice))
                out = Path(tmp) / "audio" / "fallback.mp3"
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(b"ID3")
                return {"file": "fallback.mp3", "cached": False}

            edge.synthesize = fake_edge_synth
            res = reg.synthesize("ทดสอบระบบสำรอง", "thonburian:default")
            self.assertEqual(res["fallback"], "th-TH-NiwatNeural")
            self.assertFalse(a100_voice.is_available(), "circuit breaker tripped after unreachable A100")
            self.assertEqual(len(edge_calls), 1)

    def test_parallel_batch_prefetch_groups_sentences_like_timeline_js(self):
        cues = [
            {"start": 0.0, "end": 1.5, "en": "So the function", "th": "ดังนั้นฟังก์ชันนี้"},
            {"start": 1.6, "end": 3.2, "en": "returns a string.", "th": "จะคืนค่าเป็นข้อความ"},
            {"start": 3.5, "end": 5.0, "en": "Untranslated line.", "th": ""},
            {"start": 5.2, "end": 7.0, "en": "Let us test it!", "th": "มาลองทดสอบกันเลย"},
        ]
        sentences = tts.sentences_from_cues(cues)
        self.assertEqual(
            sentences,
            ["ดังนั้นฟังก์ชันนี้ จะคืนค่าเป็นข้อความ", "มาลองทดสอบกันเลย"],
        )
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "a100-secret"}
        ):
            reg = tts.TtsRegistry(Path(tmp))
            items = reg.prefetch_texts(sentences, "thonburian:default", parallel=2)
            self.assertEqual(len(items), 2)
            self.assertEqual(len(FakeA100Server.requests), 2)

    def test_background_prefetch_follows_the_player_and_never_repeats_a_sentence(self):
        cues = [
            {"start": 0.0, "end": 1.5, "en": "One.", "th": "หนึ่ง"},
            {"start": 2.0, "end": 3.5, "en": "Two.", "th": "สอง"},
        ]
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "a100-secret", "UDTH_PREFETCH_VOICE": ""}
        ):
            reg = tts.TtsRegistry(Path(tmp))
            reg.prefetch_cues_async(cues)
            self.assertEqual(FakeA100Server.requests, [], "nothing is made before the player has dubbed")

            reg.last_voice = "openjai:default"  # the player asked for this voice
            reg.prefetch_cues_async(cues[:1])
            reg.prefetch_cues_async(cues)  # a later partial repeats the first sentence
            reg._prefetch_pool.shutdown(wait=True)
        made = [(r["voice"], r["text"]) for r in FakeA100Server.requests]
        self.assertEqual(sorted(made), [("openjai:default", "สอง"), ("openjai:default", "หนึ่ง")])

    def test_background_clips_wait_while_the_player_is_waiting_on_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            reg = tts.TtsRegistry(Path(tmp))
            clock = [100.0]
            slept = []

            def sleep(seconds):
                slept.append(seconds)
                clock[0] += seconds
                if clock[0] > 101.0:  # the live request finishes after a second
                    reg._live = 0
                    reg._live_ended = 101.0

            reg._live = 1
            reg._wait_for_quiet(sleep=sleep, now=lambda: clock[0])
            self.assertGreaterEqual(clock[0], 101.0 + tts.LIVE_QUIET_SECONDS, "and stays quiet a moment after")
            slept.clear()
            reg._wait_for_quiet(sleep=sleep, now=lambda: clock[0])
            self.assertEqual(slept, [], "nothing to wait for once the player is idle")

    def test_compressed_audio_from_the_a100_is_cached_as_wav(self):
        import base64
        import io

        import numpy as np
        import soundfile as sf

        tone = np.sin(np.linspace(0, 440 * 2 * np.pi, 24000)).astype("float32") * 0.3
        ogg = io.BytesIO()
        sf.write(ogg, tone, 24000, format="OGG", subtype="VORBIS")
        sent = {}

        def fake_request(path, body=None, **kw):
            sent.update(kw.get("headers") or {})
            return {"audio_b64": base64.b64encode(ogg.getvalue()).decode(), "format": "ogg"}

        with tempfile.TemporaryDirectory() as tmp, patch.object(a100_voice, "request_json", fake_request):
            out = Path(tmp) / "clip.wav"
            a100_voice.synthesize_remote(engine="omnivoice", voice="omnivoice:male", text="ก", output_path=out, url="http://x")
            samples, rate = sf.read(out)
            self.assertEqual(sent.get("X-Audio-Format"), "ogg", "compressed audio was asked for")
            self.assertEqual(sf.info(out).format, "WAV")
            self.assertAlmostEqual(len(samples) / rate, 1.0, places=2)

    def test_a_new_tunnel_pasted_into_env_is_used_without_a_restart(self):
        from udemy_th import env

        with tempfile.TemporaryDirectory() as tmp:
            dotenv = Path(tmp) / ".env"
            dotenv.write_text("UDTH_A100_URL=https://old.trycloudflare.com\nUDTH_A100_KEY=k1\n", encoding="utf-8")
            clean = {k: v for k, v in os.environ.items() if k not in ("UDTH_A100_URL", "UDTH_A100_KEY", "UDTH_NO_DOTENV")}
            with patch.dict(os.environ, clean, clear=True), patch.object(env, "ENV_PATH", dotenv), \
                    patch.object(env, "LOADED", []):
                a100_voice._dotenv.update(mtime=None, checked=-1e9)
                self.assertEqual(a100_voice.base_url(), "https://old.trycloudflare.com")
                dotenv.write_text("UDTH_A100_URL=https://new.trycloudflare.com\nUDTH_A100_KEY=k2\n", encoding="utf-8")
                os.utime(dotenv, (2_000_000_000, 2_000_000_000))
                a100_voice._dotenv["checked"] = -1e9  # skip the 2s throttle
                self.assertEqual(a100_voice.base_url(), "https://new.trycloudflare.com")
                self.assertEqual(a100_voice.api_key(), "k2")

            real = {**clean, "UDTH_A100_URL": "https://set-by-hand.example"}
            with patch.dict(os.environ, real, clear=True), patch.object(env, "ENV_PATH", dotenv), \
                    patch.object(env, "LOADED", []):
                a100_voice._dotenv.update(mtime=None, checked=-1e9)
                self.assertEqual(a100_voice.base_url(), "https://set-by-hand.example", "the real environment wins")

    def test_the_line_due_now_goes_to_the_gpu_before_lines_asked_ahead(self):
        import threading
        import time

        gate = a100_voice._PriorityGate()
        order = []
        release = threading.Event()

        def holder():
            with gate.turn(a100_voice.AHEAD):
                release.wait(2)

        def waiter(level, name):
            with gate.turn(level):
                order.append(name)

        first = threading.Thread(target=holder)
        first.start()
        time.sleep(0.05)
        threads = [threading.Thread(target=waiter, args=(a100_voice.BACKGROUND, "background")),
                   threading.Thread(target=waiter, args=(a100_voice.AHEAD, "ahead"))]
        for t in threads:
            t.start()
            time.sleep(0.05)
        late = threading.Thread(target=waiter, args=(a100_voice.NOW, "now"))
        late.start()
        time.sleep(0.05)
        release.set()
        for t in [first, *threads, late]:
            t.join(2)
        self.assertEqual(order, ["now", "ahead", "background"])

    def test_asr_transcribes_over_a100_and_caches_by_file(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"UDTH_A100_URL": self.url, "UDTH_A100_KEY": "a100-secret"}
        ):
            audio_file = Path(tmp) / "lecture.wav"
            audio_file.write_bytes(b"RIFF-AUDIO")
            first = asr.transcribe_file(audio_file, lang="en", cache_dir=Path(tmp))
            second = asr.transcribe_file(audio_file, lang="en", cache_dir=Path(tmp))
            self.assertEqual(first["text"], "Hello and welcome to the course.")
            self.assertEqual(len(first["cues"]), 2)
            self.assertEqual(second["cues"], first["cues"])
            self.assertEqual(len(FakeA100Server.requests), 1, "second ASR call served from cache")

    def test_colab_notebook_uses_no_deps_for_f5_tts_and_cached_path(self):
        nb_path = Path(__file__).resolve().parent.parent / "colab" / "hongrian_voice_a100.ipynb"
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        cell2 = "".join(nb["cells"][4]["source"])
        cell3 = "".join(nb["cells"][6]["source"])
        self.assertIn("--no-deps f5-tts", cell2)
        self.assertNotIn("cached-path", cell2)
        self.assertIn('sys.modules["cached_path"]', cell3)
        self.assertIn('sys.modules["wandb"]', cell3)
        self.assertIn('sys.modules["hydra.utils"]', cell3)


if __name__ == "__main__":
    unittest.main()

