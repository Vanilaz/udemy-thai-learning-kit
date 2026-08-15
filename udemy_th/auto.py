"""The one-step path: clipboard (or file, or whole folder) -> finished subtitles.

`prepare` / `translate` / `build` still exist for when you want to inspect or
redo a single stage. `go` is what you actually use day to day.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from pathlib import Path

from .build import build
from .glossary import Glossary
from .prepare import prepare

SOURCE_SUFFIXES = (".txt", ".srt", ".vtt")


def go_text(
    text: str,
    course: str,
    title: str,
    courses_root: Path,
    work_root: Path,
    out_root: Path,
    glossary: Glossary,
    engine: str = "agy",
    effort: str = "high",
    bom: bool = False,
) -> dict:
    """Save pasted transcript text, then run the whole pipeline on it."""
    slug = slugify(title) or f"lesson-{datetime.now():%Y%m%d-%H%M%S}"
    course_dir = courses_root / (slugify(course) or "my-course")
    course_dir.mkdir(parents=True, exist_ok=True)

    source = course_dir / f"{slug}.txt"
    source.write_text(text, encoding="utf-8")

    return go_file(
        source=source,
        course=course_dir.name,
        title=title,
        work_root=work_root,
        out_root=out_root,
        glossary=glossary,
        engine=engine,
        effort=effort,
        bom=bom,
    )


def go_file(
    source: Path,
    course: str,
    title: str,
    work_root: Path,
    out_root: Path,
    glossary: Glossary,
    engine: str = "agy",
    effort: str = "high",
    bom: bool = False,
) -> dict:
    """prepare -> translate -> build for a single transcript file."""
    written = prepare(
        source=source,
        work_root=work_root,
        glossary=glossary,
        course=course,
        title=title,
    )
    work_dir = written[0].parent

    if engine == "agy":
        from .translate_agy import translate

        translate(work_dir, glossary, effort=effort)
    else:
        from .translate_api import translate as translate_claude

        translate_claude(work_dir, glossary)

    return build(work_dir, glossary, out_root, bom=bom)


def go_folder(
    folder: Path,
    work_root: Path,
    out_root: Path,
    glossary: Glossary,
    engine: str = "agy",
    effort: str = "high",
    bom: bool = False,
    force: bool = False,
) -> list[dict]:
    """Run every transcript in a folder, skipping ones already finished."""
    sources = sorted(
        p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in SOURCE_SUFFIXES
    )
    if not sources:
        raise ValueError(
            f"ไม่พบไฟล์ transcript ใน {folder} (รองรับ {', '.join(SOURCE_SUFFIXES)})"
        )

    course = folder.name
    reports: list[dict] = []
    for index, source in enumerate(sources, start=1):
        done_marker = out_root / course / source.stem / f"{source.stem}.dual.srt"
        if done_marker.exists() and not force:
            print(f"[{index}/{len(sources)}] ข้าม {source.name} (ทำไว้แล้ว)")
            continue

        print(f"[{index}/{len(sources)}] {source.name}")
        try:
            reports.append(
                go_file(
                    source=source,
                    course=course,
                    title=source.stem.replace("-", " ").replace("_", " "),
                    work_root=work_root,
                    out_root=out_root,
                    glossary=glossary,
                    engine=engine,
                    effort=effort,
                    bom=bom,
                )
            )
        except (RuntimeError, ValueError) as exc:
            # One bad lesson shouldn't abandon a 200-lecture course.
            print(f"    ผิดพลาด: {exc}")
    return reports


def slugify(value: str) -> str:
    """Make a filesystem-safe slug, keeping Thai characters intact."""
    value = unicodedata.normalize("NFC", value).strip()
    value = re.sub(r"[\\/:*?\"<>|]+", "", value)
    value = re.sub(r"\s+", "-", value)
    return value.strip("-.")
