"""Translating through an OpenAI-compatible endpoint (vLLM on a Colab GPU)."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from udemy_th import translate_agy, translate_llm
from udemy_th.glossary import Glossary
from udemy_th.models import Lesson, Segment


class FakeOpenAI(BaseHTTPRequestHandler):
    """Answers /v1/models and /v1/chat/completions like vLLM does."""

    key = "secret"
    requests: list = []

    def log_message(self, *args):
        pass

    def _reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorised(self) -> bool:
        if self.headers.get("Authorization") != f"Bearer {self.key}":
            self._reply(401, {"error": "bad key"})
            return False
        return True

    def do_GET(self):
        if self._authorised():
            self._reply(200, {"data": [{"id": "scb10x/typhoon2.1-gemma3-12b"}]})

    def do_POST(self):
        if not self._authorised():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeOpenAI.requests.append(body)
        prompt = body["messages"][0]["content"]
        # Answer every line id in the prompt, the way the real model does.
        ids = [line.split("]]")[0][2:] for line in prompt.splitlines() if line.startswith("[[") and "]]" in line]
        answer = "## SUBTITLES\n" + "\n".join(f"[[{i}]] คำแปล {i}" for i in ids)
        self._reply(200, {"choices": [{"message": {"content": answer}}]})


class LlmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), FakeOpenAI)
        cls.url = f"http://127.0.0.1:{cls.server.server_port}/v1"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        FakeOpenAI.requests = []

    def test_the_model_is_asked_from_the_server_when_not_configured(self):
        run = translate_llm.runner(self.url, "secret", model=None)
        self.assertIn("## SUBTITLES", run("[[1]] Hello", "chunk 1"))
        self.assertEqual(FakeOpenAI.requests[0]["model"], "scb10x/typhoon2.1-gemma3-12b")

    def test_a_wrong_key_is_named_not_retried_elsewhere(self):
        run = translate_llm.with_fallback(
            translate_llm.runner(self.url, "wrong", model="m"), lambda p, l: "agy answer", log=lambda *a, **k: None
        )
        with self.assertRaises(RuntimeError) as caught:
            run("[[1]] Hello", "chunk 1")
        self.assertIn("UDTH_LLM_KEY", str(caught.exception))
        self.assertNotIsInstance(caught.exception, translate_llm.LlmUnavailable)

    def test_an_unreachable_endpoint_hands_the_chunk_to_agy_and_rests(self):
        clock = [0.0]
        tried = []

        def down(prompt, label):
            tried.append(label)
            raise translate_llm.LlmUnavailable("Colab disconnected")

        run = translate_llm.with_fallback(down, lambda p, l: f"agy:{l}", now=lambda: clock[0], log=lambda *a, **k: None)
        self.assertEqual(run("p", "a"), "agy:a")
        self.assertEqual(run("p", "b"), "agy:b")
        self.assertEqual(tried, ["a"], "no second timeout while it is known to be down")
        clock[0] = translate_llm.RETRY_AFTER_SECONDS + 1
        run("p", "c")
        self.assertEqual(tried, ["a", "c"], "tried again once the rest is over")

    def test_a_dead_address_counts_as_unavailable(self):
        run = translate_llm.runner("http://127.0.0.1:9/v1", "k", model="m", timeout=2)
        with self.assertRaises(translate_llm.LlmUnavailable):
            run("p", "chunk")

    def test_a_whole_lecture_goes_through_the_same_chunked_path(self):
        lesson = Lesson("s", "t", "c", [Segment(i, f"Line {i}.", float(i), i + 0.9) for i in range(1, 6)])
        with tempfile.TemporaryDirectory() as tmp:
            glossary = Glossary(Path(tmp) / "g.json")
            answers = translate_agy.translate_text(
                lesson, glossary, run_chunk=translate_llm.runner(self.url, "secret", model="m"), parallel=4
            )
        self.assertEqual(len(FakeOpenAI.requests), len(answers))
        self.assertTrue(all("## SUBTITLES" in a for a in answers))
        self.assertIn("[[5]] คำแปล 5", "\n".join(answers))

    def test_a_short_context_model_gets_smaller_chunks_sent_together(self):
        lesson = Lesson("s", "t", "c", [Segment(i, "word " * 40, float(i), i + 0.9) for i in range(1, 41)])
        with tempfile.TemporaryDirectory() as tmp:
            glossary = Glossary(Path(tmp) / "g.json")
            answers = translate_agy.translate_text(
                lesson, glossary, run_chunk=translate_llm.runner(self.url, "secret", model="m"),
                parallel=8, chunk_chars=2000,
            )
        self.assertGreater(len(answers), 4, "40 lines of ~200 chars do not fit 2000 chars a chunk")
        bodies = [r["messages"][0]["content"] for r in FakeOpenAI.requests]
        for body in bodies:
            transcript = [line for line in body.splitlines() if line.startswith("[[") and "word" in line]
            self.assertLessEqual(sum(len(line) + 1 for line in transcript), 2000 + 210)
        self.assertNotIn("max_tokens", FakeOpenAI.requests[0], "the server sizes the answer to the context left")


    def test_normalize_url(self):
        self.assertEqual(translate_llm.normalize_url("https://api.sunisaphas.com/v1"), "https://api.sunisaphas.com/v1")
        self.assertEqual(translate_llm.normalize_url("https://api.sunisaphas.com"), "https://api.sunisaphas.com/v1")
        self.assertEqual(translate_llm.normalize_url("http://localhost:11434"), "http://localhost:11434/v1")
        self.assertEqual(translate_llm.normalize_url("http://localhost:11434/v1/"), "http://localhost:11434/v1")

    def test_clean_llm_response_strips_think_tags(self):
        raw = "<think>\nThinking about translation...\n</think>\n## SUBTITLES\n[[1]] คำแปล"
        cleaned = translate_llm.clean_llm_response(raw)
        self.assertEqual(cleaned, "## SUBTITLES\n[[1]] คำแปล")

    def test_clean_llm_response_strips_markdown_code_fences(self):
        raw = "```markdown\n## SUBTITLES\n[[1]] คำแปล\n```"
        cleaned = translate_llm.clean_llm_response(raw)
        self.assertEqual(cleaned, "## SUBTITLES\n[[1]] คำแปล")

    def test_env_var_fallbacks(self):
        import os
        old = dict(os.environ)
        try:
            for k in ["UDTH_LLM_URL", "UDTH_LLM_KEY", "UDTH_LLM_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"]:
                os.environ.pop(k, None)
            os.environ["OPENAI_BASE_URL"] = "https://api.sunisaphas.com"
            os.environ["OPENAI_API_KEY"] = "sk-test"
            os.environ["OPENAI_MODEL"] = "deepseek-chat"

            self.assertEqual(translate_llm.get_url(), "https://api.sunisaphas.com/v1")
            self.assertEqual(translate_llm.get_key(), "sk-test")
            self.assertEqual(translate_llm.get_model(), "deepseek-chat")
            self.assertTrue(translate_llm.configured())
        finally:
            os.environ.clear()
            os.environ.update(old)


    def test_sse_streaming_response_is_accumulated(self):
        sse_body = (
            'data: {"choices":[{"delta":{"content":"## SUBTITLES\\n"}}]}\n\n'
            'data: {"choices":[{"delta":{"content":"[[1]] คำแปล"}}]}\n\n'
            'data: [DONE]\n\n'
        )
        class SseServer(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                self.wfile.write(sse_body.encode("utf-8"))

        server = HTTPServer(("127.0.0.1", 0), SseServer)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/v1"
            run = translate_llm.runner(url, "secret", model="sse-model")
            ans = run("[[1]] Hello", "label")
            self.assertEqual(ans, "## SUBTITLES\n[[1]] คำแปล")
        finally:
            server.shutdown()

    def test_runner_falls_back_to_secondary_model_on_error(self):
        calls = []
        class FallbackMock(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model = body["model"]
                calls.append(model)
                if model == "primary-model":
                    self.send_response(429)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error": "rate limit reached"}')
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"choices":[{"message":{"content":"## SUBTITLES\\n[[1]] Translated via fallback"}}]}')

        server = HTTPServer(("127.0.0.1", 0), FallbackMock)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_port}/v1"
            logs = []
            run = translate_llm.runner(
                url, "secret", model="primary-model", fallback_model="ag/gemini-3.8-flash-high", log=logs.append
            )
            ans = run("[[1]] Hello", "test-label")
            self.assertEqual(ans, "## SUBTITLES\n[[1]] Translated via fallback")
            self.assertEqual(calls, ["primary-model", "ag/gemini-3.8-flash-high"])
            self.assertTrue(any("สลับไปใช้โมเดลสำรอง" in l for l in logs))
        finally:
            server.shutdown()


if __name__ == "__main__":
    unittest.main()
