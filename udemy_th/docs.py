"""Translate handout files that came with a lecture.

Udemy lets instructors attach resources — PDF slides, notes, cheat sheets.
Download them the normal way (the Resources button in the player), then point
this at the file or the folder.

Text extraction is stdlib-only except for PDF, which uses PyMuPDF if present.
Source-code attachments are deliberately skipped: translating code would break
it, and the accompanying prose is what you actually need in Thai.
"""

from __future__ import annotations

import html
import re
import zipfile
from html.parser import HTMLParser
from pathlib import Path

from .glossary import Glossary
from .models import Lesson, Segment

TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".rst"}
HTML_SUFFIXES = {".html", ".htm"}
SUPPORTED = TEXT_SUFFIXES | HTML_SUFFIXES | {".pdf", ".docx"}

# Attachments that are source code or archives — nothing to translate.
SKIP_SUFFIXES = {
    ".zip", ".rar", ".7z", ".cs", ".js", ".ts", ".py", ".java", ".sql",
    ".json", ".xml", ".csproj", ".sln", ".png", ".jpg", ".jpeg", ".gif",
    ".mp4", ".exe", ".dll",
}

# Anything shorter than this is a stray fragment, not a paragraph.
MIN_BLOCK_CHARS = 3


class _TextExtractor(HTMLParser):
    """Collect visible text, one entry per block-level element."""

    _SKIP = {"script", "style", "head", "meta", "link"}
    _BLOCK = {
        "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6",
        "td", "th", "pre", "blockquote", "section", "article", "br", "tr",
    }

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self._buffer: list[str] = []
        self._skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skipping += 1
        elif tag in self._BLOCK:
            self._flush()

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skipping:
            self._skipping -= 1
        elif tag in self._BLOCK:
            self._flush()

    def handle_data(self, data):
        if not self._skipping and data.strip():
            self._buffer.append(data)

    def _flush(self):
        text = " ".join(self._buffer).strip()
        if text:
            self.blocks.append(text)
        self._buffer = []

    def close(self):
        super().close()
        self._flush()


def extract_blocks(path: Path) -> list[str]:
    """Return the file's text as paragraph-sized blocks."""
    suffix = path.suffix.lower()

    if suffix in TEXT_SUFFIXES:
        return _split_paragraphs(path.read_text(encoding="utf-8", errors="replace"))

    if suffix in HTML_SUFFIXES:
        parser = _TextExtractor()
        parser.feed(path.read_text(encoding="utf-8", errors="replace"))
        parser.close()
        return _clean(parser.blocks)

    if suffix == ".pdf":
        return _clean(_extract_pdf(path))

    if suffix == ".docx":
        return _clean(_extract_docx(path))

    raise ValueError(f"ยังไม่รองรับไฟล์ชนิด {suffix}")


def _extract_pdf(path: Path) -> list[str]:
    try:
        import fitz  # PyMuPDF
    except ImportError as exc:
        raise RuntimeError(
            "อ่าน PDF ต้องติดตั้ง PyMuPDF ก่อน: python -m pip install pymupdf"
        ) from exc

    blocks: list[str] = []
    with fitz.open(path) as document:
        for page in document:
            # "blocks" keeps the visual grouping, which maps well to paragraphs.
            for block in page.get_text("blocks"):
                text = (block[4] or "").strip()
                if text:
                    blocks.append(" ".join(text.split()))
    return blocks


def _extract_docx(path: Path) -> list[str]:
    """A .docx is a zip; the body text lives in word/document.xml."""
    with zipfile.ZipFile(path) as archive:
        xml = archive.read("word/document.xml").decode("utf-8", errors="replace")

    # Paragraph breaks, then strip the remaining tags.
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    return [html.unescape(line).strip() for line in text.split("\n") if line.strip()]


def _split_paragraphs(text: str) -> list[str]:
    return _clean(re.split(r"\n\s*\n", text.replace("\r\n", "\n")))


def _clean(blocks: list[str]) -> list[str]:
    out: list[str] = []
    for block in blocks:
        collapsed = " ".join(block.split())
        if len(collapsed) >= MIN_BLOCK_CHARS:
            out.append(collapsed)
    return out


def translate_document(
    source: Path,
    glossary: Glossary,
    out_root: Path,
    engine: str = "agy",
    effort: str = "high",
) -> dict:
    """Translate one handout; write <name>.th.md next to the output root."""
    blocks = extract_blocks(source)
    if not blocks:
        raise ValueError(f"ไม่พบข้อความในไฟล์: {source.name}")

    lesson = Lesson(
        slug=source.stem,
        title=source.stem.replace("-", " ").replace("_", " "),
        course=source.parent.name,
        segments=[Segment(id=i, text=b) for i, b in enumerate(blocks, start=1)],
    )

    if engine == "claude":
        from .translate_api import translate_text

        answers = translate_text(lesson, glossary, mode="doc")
    else:
        from .translate_agy import translate_text

        answers = translate_text(lesson, glossary, effort=effort, mode="doc")

    from .build import _parse_subtitles, _parse_terms, _split_sections

    by_id: dict[int, str] = {}
    terms = []
    for answer in answers:
        sections = _split_sections(answer)
        by_id.update(_parse_subtitles(sections.get("SUBTITLES", "")))
        terms.extend(_parse_terms(sections.get("TERMS", ""), lesson.slug))

    if not by_id:
        raise RuntimeError("แปลแล้วแต่อ่านผลลัพธ์ไม่ได้")

    new_terms = sum(1 for term in terms if glossary.add(term))
    glossary.save()

    out_dir = out_root / lesson.course
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{source.stem}.th.md"

    lines = [f"# {lesson.title}", "", f"_แปลจาก: {source.name}_", "", "---", ""]
    for segment in lesson.segments:
        lines.append(by_id.get(segment.id, segment.text))
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")

    return {
        "source": source.name,
        "blocks": len(blocks),
        "translated": len(by_id),
        "new_terms": new_terms,
        "out": out_path,
    }


def translate_folder(
    folder: Path,
    glossary: Glossary,
    out_root: Path,
    engine: str = "agy",
    effort: str = "high",
) -> list[dict]:
    """Translate every supported handout in a folder, skipping code archives."""
    files = sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in SUPPORTED
    )
    skipped = [
        p.name for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in SKIP_SUFFIXES
    ]
    if skipped:
        print(f"ข้าม {len(skipped)} ไฟล์ที่เป็นโค้ด/บีบอัด/รูปภาพ")
    if not files:
        raise ValueError(f"ไม่พบไฟล์เอกสารที่รองรับใน {folder}")

    reports = []
    for index, path in enumerate(files, start=1):
        print(f"[{index}/{len(files)}] {path.name}")
        try:
            reports.append(
                translate_document(path, glossary, out_root, engine, effort)
            )
        except (RuntimeError, ValueError) as exc:
            print(f"    ผิดพลาด: {exc}")
    return reports
