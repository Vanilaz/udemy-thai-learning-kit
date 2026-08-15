"""Build the work packet Claude Code translates.

This is the free path: no API key, no cost. `prepare` writes a request file,
you ask Claude Code in this project to fill it in, `build` reads the answer
back and produces the subtitles, summary, and glossary updates.
"""

from __future__ import annotations

from pathlib import Path

from .glossary import Glossary
from .models import Lesson
from .prompts import OUTPUT_FORMAT, RULES

# Lessons longer than this are split so a single request stays comfortable.
MAX_SEGMENTS_PER_PART = 400

_INSTRUCTIONS = """\
# คำขอแปลบทเรียน — {title}

> ไฟล์นี้สร้างโดย `udemy_th prepare` — ให้ Claude Code อ่านไฟล์นี้แล้วเขียนคำตอบลงที่
> `{answer_path}` ตามรูปแบบท้ายไฟล์ จากนั้นรัน `python -m udemy_th build {work_dir}`

**คอร์ส:** {course}
**บทเรียน:** {title}
**จำนวนบรรทัด:** {count}{part_note}

---

## คำสั่งสำหรับผู้แปล

{rules}

---

## คลังศัพท์ที่แปลไว้แล้ว (ใช้คำเดิมเพื่อความสม่ำเสมอทั้งคอร์ส)

{glossary_block}

---

## ต้นฉบับ

{body}

---

## รูปแบบคำตอบ — เขียนลงไฟล์ `{answer_filename}`

{output_format}
"""


def prepare(
    source: Path,
    work_root: Path,
    glossary: Glossary,
    course: str = "",
    title: str = "",
) -> list[Path]:
    """Parse `source`, write lesson.json and one request file per part.

    Returns the request files that were written.
    """
    from . import parser  # local import keeps module import cost low

    raw = source.read_text(encoding="utf-8")
    segments = parser.parse(raw)
    if not segments:
        raise ValueError(f"ไม่พบเนื้อหาที่อ่านได้ในไฟล์: {source}")

    slug = source.stem
    lesson = Lesson(
        slug=slug,
        title=title or slug.replace("-", " ").replace("_", " ").strip(),
        course=course or source.parent.name,
        segments=segments,
    )

    work_dir = work_root / lesson.course / slug
    work_dir.mkdir(parents=True, exist_ok=True)
    lesson.save(work_dir / "lesson.json")

    parts = [
        segments[i : i + MAX_SEGMENTS_PER_PART]
        for i in range(0, len(segments), MAX_SEGMENTS_PER_PART)
    ]
    glossary_block = glossary.as_prompt_block(glossary.relevant_to(lesson.source_text))

    written: list[Path] = []
    for index, part in enumerate(parts, start=1):
        suffix = "" if len(parts) == 1 else f"-part{index:02d}"
        request_path = work_dir / f"translate-request{suffix}.md"
        answer_filename = f"translated{suffix}.md"
        part_note = (
            "" if len(parts) == 1 else f" (ส่วนที่ {index} จาก {len(parts)})"
        )
        body = "\n".join(f"[[{s.id}]] {s.text}" for s in part)

        request_path.write_text(
            _INSTRUCTIONS.format(
                title=lesson.title,
                course=lesson.course,
                count=len(part),
                part_note=part_note,
                rules=RULES,
                glossary_block=glossary_block,
                body=body,
                answer_path=(work_dir / answer_filename).as_posix(),
                answer_filename=answer_filename,
                work_dir=work_dir.as_posix(),
                output_format=OUTPUT_FORMAT.format(
                    first_id=part[0].id, last_id=part[-1].id
                ),
            ),
            encoding="utf-8",
        )
        written.append(request_path)

    return written
