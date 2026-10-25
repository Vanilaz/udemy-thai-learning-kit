"""Read the translated answer back and produce the study materials."""

from __future__ import annotations

import re
from pathlib import Path

from .glossary import Glossary
from .models import Lesson, Term
from .srt import to_srt

_SECTION = re.compile(r"^##\s*(SUBTITLES|SUMMARY|TERMS)\s*$", re.MULTILINE)
_LINE_ID = re.compile(r"^\s*\[\[(\d+)\]\]\s*(.*)$")


class BuildError(Exception):
    """Raised when the answer file is missing or unusable."""


def build(
    work_dir: Path, glossary: Glossary, out_root: Path, bom: bool = False
) -> dict:
    """Merge every translated*.md in `work_dir` into finished output.

    `bom` writes the .srt files as UTF-8 with a byte-order mark. Browser
    subtitle extensions read plain UTF-8 fine, but desktop players on Windows
    (VLC, PotPlayer, MPC-HC) often guess the ANSI codepage without a BOM and
    render Thai as garbage. Returns a report dict for the CLI to print.
    """
    lesson_path = work_dir / "lesson.json"
    if not lesson_path.exists():
        raise BuildError(f"ไม่พบ {lesson_path} — รัน prepare ก่อน")
    lesson = Lesson.load(lesson_path)

    answers = sorted(work_dir.glob("translated*.md"))
    if not answers:
        raise BuildError(
            f"ไม่พบไฟล์คำแปลใน {work_dir}\n"
            f"  ให้ Claude Code อ่าน translate-request*.md แล้วเขียน translated*.md"
        )

    by_id: dict[int, str] = {}
    summaries: list[str] = []
    terms: list[Term] = []
    for answer in answers:
        sections = _split_sections(answer.read_text(encoding="utf-8"))
        by_id.update(_parse_subtitles(sections.get("SUBTITLES", "")))
        if sections.get("SUMMARY", "").strip():
            summaries.append(sections["SUMMARY"].strip())
        terms.extend(_parse_terms(sections.get("TERMS", ""), lesson.slug))

    if not by_id:
        raise BuildError(
            "อ่านคำแปลไม่ได้เลย — ตรวจว่าไฟล์ translated*.md มีหัวข้อ `## SUBTITLES` "
            "และแต่ละบรรทัดขึ้นต้นด้วย [[หมายเลข]]"
        )

    for segment in lesson.segments:
        if segment.id in by_id:
            segment.thai = by_id[segment.id]

    missing = [s.id for s in lesson.segments if not s.thai]
    lesson.summary = "\n\n".join(summaries)
    lesson.save(lesson_path)

    new_terms = sum(1 for term in terms if glossary.add(term))
    glossary.save()

    out_dir = out_root / lesson.course / lesson.slug
    out_dir.mkdir(parents=True, exist_ok=True)
    srt_encoding = "utf-8-sig" if bom else "utf-8"
    (out_dir / f"{lesson.slug}.th.srt").write_text(
        to_srt(lesson.segments, mode="thai"), encoding=srt_encoding
    )
    (out_dir / f"{lesson.slug}.dual.srt").write_text(
        to_srt(lesson.segments, mode="dual"), encoding=srt_encoding
    )
    (out_dir / f"{lesson.slug}.summary.md").write_text(
        _summary_doc(lesson, terms), encoding="utf-8"
    )

    return {
        "lesson": lesson.title,
        "out_dir": out_dir,
        "translated": lesson.translated_count,
        "total": len(lesson.segments),
        "missing": missing,
        "new_terms": new_terms,
        "seen_terms": len(terms),
    }


def _split_sections(text: str) -> dict[str, str]:
    """Split the answer file on its `## SECTION` headings."""
    matches = list(_SECTION.finditer(text))
    sections: dict[str, str] = {}
    for i, match in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[match.group(1)] = text[match.end() : end]
    return sections


def _format_thai_spacing(text: str) -> str:
    """Ensure spaces between Thai script and Latin/digits, adhering to Thai typography."""
    text = re.sub(r"([\u0e00-\u0e7f])([A-Za-z0-9])", r"\1 \2", text)
    text = re.sub(r"([A-Za-z0-9])([\u0e00-\u0e7f])", r"\1 \2", text)
    return text


def _parse_subtitles(block: str) -> dict[int, str]:
    result: dict[int, str] = {}
    current: int | None = None
    for line in block.split("\n"):
        match = _LINE_ID.match(line)
        if match:
            current = int(match.group(1))
            result[current] = _format_thai_spacing(match.group(2).strip())
        elif current is not None and line.strip():
            # A translation that wrapped onto the next line.
            result[current] = _format_thai_spacing((result[current] + " " + line.strip()).strip())
        else:
            current = None
    return {k: v for k, v in result.items() if v}


def _parse_terms(block: str, lesson_slug: str) -> list[Term]:
    terms: list[Term] = []
    for line in block.split("\n"):
        line = line.strip().lstrip("-*").strip()
        if not line or line.startswith(("#", "|", "```")):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 2 or not parts[0]:
            continue
        keep = True
        explanation = ""
        if len(parts) >= 3:
            keep = parts[2].lower() != "translate"
        if len(parts) >= 4:
            explanation = parts[3]
        terms.append(
            Term(
                term=parts[0],
                thai=parts[1],
                explanation=explanation,
                keep_english=keep,
                lessons=[lesson_slug],
            )
        )
    return terms


def _summary_doc(lesson: Lesson, terms: list[Term]) -> str:
    lines = [f"# {lesson.title}", ""]
    if lesson.course:
        lines += [f"**คอร์ส:** {lesson.course}", ""]
    lines += [lesson.summary or "_(ยังไม่มีสรุป)_", ""]

    if terms:
        lines += ["---", "", "## ศัพท์ในบทนี้", ""]
        for term in terms:
            note = " *(คงคำอังกฤษ)*" if term.keep_english else ""
            lines.append(f"- **{term.term}** — {term.thai}{note}")
            if term.explanation:
                lines.append(f"  - {term.explanation}")
        lines.append("")

    return "\n".join(lines)
