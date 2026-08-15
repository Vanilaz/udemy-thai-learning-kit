"""Optional path: translate through the Claude API instead of Claude Code.

Only useful once you have credentials (`ANTHROPIC_API_KEY`, or `ant auth login`).
Without them, use the free path — `prepare` then ask Claude Code to translate.

The output written here is byte-identical in shape to what the free path
produces, so `build` handles both without caring which was used.
"""

from __future__ import annotations

from pathlib import Path

from .glossary import Glossary
from .models import Lesson
from .prepare import MAX_SEGMENTS_PER_PART
from .prompts import DOC_OUTPUT_FORMAT, DOC_RULES, OUTPUT_FORMAT, RULES, SYSTEM

MODEL = "claude-opus-4-8"
# Streaming is required at this size — a non-streaming request would risk an
# HTTP timeout before the model finishes a long lecture.
MAX_TOKENS = 64_000

_USER_TEMPLATE = """\
{rules}

---

## คลังศัพท์ที่แปลไว้แล้ว (ใช้คำเดิมเพื่อความสม่ำเสมอทั้งคอร์ส)

{glossary_block}

---

## ต้นฉบับ — {title}

{body}

---

## รูปแบบคำตอบ

{output_format}
"""


def translate_text(
    lesson: Lesson, glossary: Glossary, mode: str = "subtitle"
) -> list[str]:
    """Translate a Lesson in memory; return each chunk's raw answer text.

    `mode` picks the rule set: "subtitle" for caption lines, "doc" for article
    and handout prose (where code blocks must survive untranslated).
    """
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - depends on install
        raise RuntimeError(
            "ต้องติดตั้ง SDK ก่อน: python -m pip install anthropic"
        ) from exc

    # A bare client resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    # `ant auth login` profile — in that order.
    client = anthropic.Anthropic()

    segments = lesson.segments
    parts = [
        segments[i : i + MAX_SEGMENTS_PER_PART]
        for i in range(0, len(segments), MAX_SEGMENTS_PER_PART)
    ]
    glossary_block = glossary.as_prompt_block(glossary.relevant_to(lesson.source_text))

    answers: list[str] = []
    for part in parts:
        prompt = _USER_TEMPLATE.format(
            rules=DOC_RULES if mode == "doc" else RULES,
            glossary_block=glossary_block,
            title=lesson.title,
            body="\n".join(f"[[{s.id}]] {s.text}" for s in part),
            output_format=(DOC_OUTPUT_FORMAT if mode == "doc" else OUTPUT_FORMAT).format(
                first_id=part[0].id, last_id=part[-1].id
            ),
        )

        try:
            with client.messages.stream(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                system=SYSTEM,
                thinking={"type": "adaptive"},
                output_config={"effort": "high"},
                messages=[{"role": "user", "content": prompt}],
            ) as stream:
                response = stream.get_final_message()
        except anthropic.AuthenticationError as exc:
            raise RuntimeError(
                "ยืนยันตัวตนไม่ผ่าน — ตั้ง ANTHROPIC_API_KEY หรือรัน `ant auth login`"
            ) from exc
        except anthropic.RateLimitError as exc:
            raise RuntimeError("โดนจำกัดอัตราการเรียก ลองใหม่อีกครั้งภายหลัง") from exc
        except anthropic.APIStatusError as exc:
            raise RuntimeError(f"API error {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise RuntimeError("เชื่อมต่อ API ไม่ได้ ตรวจอินเทอร์เน็ต") from exc

        if response.stop_reason == "refusal":
            raise RuntimeError("โมเดลปฏิเสธคำขอนี้")
        if response.stop_reason == "max_tokens":
            raise RuntimeError(
                f"คำตอบยาวเกิน max_tokens — ลด MAX_SEGMENTS_PER_PART "
                f"(ตอนนี้ {MAX_SEGMENTS_PER_PART}) แล้ว prepare ใหม่"
            )

        answers.append("".join(b.text for b in response.content if b.type == "text"))

    return answers


def translate(work_dir: Path, glossary: Glossary) -> list[Path]:
    """Translate every part of a prepared lesson; write translated*.md files."""
    lesson_path = work_dir / "lesson.json"
    if not lesson_path.exists():
        raise RuntimeError(f"ไม่พบ {lesson_path} — รัน prepare ก่อน")
    lesson = Lesson.load(lesson_path)

    answers = translate_text(lesson, glossary)

    written: list[Path] = []
    for index, answer in enumerate(answers, start=1):
        suffix = "" if len(answers) == 1 else f"-part{index:02d}"
        answer_path = work_dir / f"translated{suffix}.md"
        answer_path.write_text(answer, encoding="utf-8")
        written.append(answer_path)
    return written
