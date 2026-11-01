import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from udemy_th.translation_review import reviewed_runner
from udemy_th.glossary import Glossary, course_glossary_path
from udemy_th.models import Term


class TranslationReviewTests(unittest.TestCase):
    prompt = "## ต้นฉบับ — Welcome\n[[1]] Use .NET 11 and `Program.cs`.\n[[2]] Happy path.\n\n## รูปแบบคำตอบ\n[[1]] example\n"
    draft = "## SUBTITLES\n[[1]] ใช้ .NET 11 และ `Program.cs`\n[[2]] happy path\n\n## TERMS\n"
    improved = "## SUBTITLES\n[[1]] ใช้ .NET 11 และ `Program.cs`\n[[2]] กรณีที่ทุกอย่างทำงานปกติ (happy path)\n\n## TERMS\n"

    def test_second_pass_improves_without_discarding_source_context(self):
        run = Mock(side_effect=[self.draft, self.improved])
        self.assertEqual(reviewed_runner(run)(self.prompt, "part"), self.improved)
        self.assertIn(self.prompt, run.call_args.args[0])
        self.assertIn(self.draft, run.call_args.args[0])

    def test_incomplete_review_keeps_draft(self):
        run = Mock(side_effect=[self.draft, "## SUBTITLES\n[[1]] only one line"])
        self.assertEqual(reviewed_runner(run, log=lambda *a, **k: None)(self.prompt, "p"), self.draft)

    def test_number_or_code_changes_are_rejected(self):
        for bad in (self.improved.replace("11", "12"), self.improved.replace("11", "111"), self.improved.replace("happy path)", "happy path) 42"),
                    self.improved.replace("`Program.cs`", "`Startup.cs`")):
            run = Mock(side_effect=[self.draft, bad])
            self.assertEqual(reviewed_runner(run, log=lambda *a, **k: None)(self.prompt, "p"), self.draft)

    def test_review_outage_does_not_discard_translation_or_log_secret(self):
        logs = []
        run = Mock(side_effect=[self.draft, RuntimeError("secret-key")])
        answer = reviewed_runner(run, log=lambda *a, **k: logs.append(a))(self.prompt, "p")
        self.assertEqual(answer, self.draft)
        self.assertNotIn("secret-key", str(logs))

    def test_server_uses_review_for_api_and_can_disable_it(self):
        import os
        from udemy_th import server, translate_llm
        from udemy_th.models import Lesson, Segment
        lesson = Lesson("qa", "Demo", "course", [Segment(1, "Use .NET 11 and `Program.cs`."), Segment(2, "Happy path.")])
        with tempfile.TemporaryDirectory() as tmp:
            for enabled, calls in (("1", 2), ("0", 1)):
                run = Mock(side_effect=[self.draft, self.improved])
                with patch.dict(os.environ, {"UDTH_LLM_URL": "http://test.invalid/v1", "UDTH_LLM_REVIEW": enabled}), patch.object(translate_llm, "runner", return_value=run), patch.object(server, "_set_job"):
                    answers = server._translate(lesson, Glossary(Path(tmp) / "g.json"), "agy", "medium", "qa", "subtitle", None)
                self.assertEqual(run.call_count, calls)
                self.assertEqual(answers[0], (self.improved if enabled == "1" else self.draft).strip())

    def test_courses_do_not_learn_each_others_terms(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp) / "shared.json"
            first = course_glossary_path(base, "course-one")
            second = course_glossary_path(base, "../course-two")
            glossary = Glossary(first)
            glossary.add(Term("N-tier", "สถาปัตยกรรมหลายชั้น", "แยกความรับผิดชอบเป็นชั้น"))
            glossary.save()
            self.assertIn("n-tier", Glossary(first).terms)
            self.assertFalse(Glossary(second).terms)
            self.assertEqual(second.parent, base.parent / "by-course")


if __name__ == "__main__":
    unittest.main()
