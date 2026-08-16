"""Command line entry point: python -m udemy_th <command>"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .build import BuildError, build
from .glossary import Glossary
from .prepare import prepare

ROOT = Path(__file__).resolve().parent.parent
COURSES = ROOT / "courses"
WORK = ROOT / "work"
OUT = ROOT / "out"
GLOSSARY_PATH = ROOT / "glossary" / "glossary.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="udemy_th",
        description="แปลบทเรียน Udemy เป็นไทย พร้อมสรุปและคลังศัพท์",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_go = sub.add_parser(
        "go", help="ทำทุกขั้นตอนในคำสั่งเดียว (ไม่ระบุ source = อ่านจาก clipboard)"
    )
    p_go.add_argument(
        "source",
        nargs="?",
        type=Path,
        default=None,
        help="ไฟล์ transcript หรือโฟลเดอร์คอร์ส (เว้นว่างไว้ = อ่านจาก clipboard)",
    )
    p_go.add_argument("--course", default="", help="ชื่อคอร์ส")
    p_go.add_argument("--name", default="", help="ชื่อบทเรียน")
    p_go.add_argument("--engine", choices=("agy", "claude"), default="agy")
    p_go.add_argument("--effort", choices=("low", "medium", "high"), default="high")
    p_go.add_argument("--bom", action="store_true", help="เขียน .srt แบบ UTF-8 with BOM")
    p_go.add_argument("--force", action="store_true", help="ทำซ้ำบทที่เคยทำแล้ว")
    # ตัวเรียกแบบ .cmd ถามเองไม่ได้ เพราะไฟล์ .cmd ต้องเป็น ASCII ล้วน
    # (ดูหมายเหตุใน start-server.cmd) จึงให้ Python เป็นคนถามแทน
    p_go.add_argument(
        "--ask-folder",
        action="store_true",
        help="ถามหาโฟลเดอร์คอร์ส แทนการอ่านจาก clipboard",
    )
    p_go.add_argument("--no-open", action="store_true", help="ไม่ต้องเปิดโฟลเดอร์ผลลัพธ์")

    p_prepare = sub.add_parser("prepare", help="เตรียมไฟล์คำขอแปลจาก transcript")
    p_prepare.add_argument("source", type=Path, help="ไฟล์ transcript (.txt/.srt/.vtt)")
    p_prepare.add_argument("--course", default="", help="ชื่อคอร์ส (ค่าปริยาย: ชื่อโฟลเดอร์)")
    p_prepare.add_argument("--title", default="", help="ชื่อบทเรียน (ค่าปริยาย: ชื่อไฟล์)")

    p_build = sub.add_parser("build", help="รวมคำแปลเป็น .srt + สรุป + คลังศัพท์")
    p_build.add_argument("work_dir", type=Path, help="โฟลเดอร์งานที่ prepare สร้างไว้")
    p_build.add_argument(
        "--bom",
        action="store_true",
        help="เขียน .srt แบบ UTF-8 with BOM (ใช้เมื่อเปิดใน VLC/PotPlayer แล้วไทยเพี้ยน)",
    )

    p_translate = sub.add_parser("translate", help="แปลอัตโนมัติ")
    p_translate.add_argument("work_dir", type=Path)
    p_translate.add_argument(
        "--engine",
        choices=("agy", "claude"),
        default="agy",
        help="agy = Antigravity CLI (ไม่ต้องมี API key), claude = Claude API",
    )
    p_translate.add_argument(
        "--effort",
        choices=("low", "medium", "high"),
        default="high",
        help="ระดับการคิดของโมเดล (เฉพาะ engine agy)",
    )
    p_translate.add_argument("--model", default=None, help="ระบุโมเดล (เฉพาะ engine agy)")

    p_glossary = sub.add_parser("glossary", help="ส่งออกคลังศัพท์เป็น Markdown")
    p_glossary.add_argument("--course", default="", help="ชื่อคอร์สสำหรับหัวเรื่อง")
    p_glossary.add_argument(
        "--out", type=Path, default=ROOT / "glossary" / "glossary.md"
    )

    p_docs = sub.add_parser(
        "docs", help="แปลไฟล์เอกสารแนบ (PDF / DOCX / TXT / MD / HTML)"
    )
    p_docs.add_argument(
        "source",
        nargs="?",
        type=Path,
        default=None,
        help="ไฟล์ หรือโฟลเดอร์ที่มีไฟล์เอกสาร (เว้นว่างไว้ = ถามทีหลัง)",
    )
    p_docs.add_argument("--engine", choices=("agy", "claude"), default="agy")
    p_docs.add_argument("--effort", choices=("low", "medium", "high"), default="high")
    p_docs.add_argument("--no-open", action="store_true", help="ไม่ต้องเปิดโฟลเดอร์ผลลัพธ์")

    p_serve = sub.add_parser(
        "serve", help="เปิดเซิร์ฟเวอร์แปลซับสำหรับ Chrome extension"
    )
    p_serve.add_argument("--engine", choices=("agy", "claude"), default="agy")
    p_serve.add_argument("--effort", choices=("low", "medium", "high"), default="high")
    p_serve.add_argument("--port", type=int, default=8765)

    sub.add_parser("status", help="ดูสถานะบทเรียนทั้งหมด")

    args = parser.parse_args(argv)
    glossary = Glossary(GLOSSARY_PATH)

    try:
        if args.command == "go":
            return _cmd_go(args, glossary)
        if args.command == "prepare":
            return _cmd_prepare(args, glossary)
        if args.command == "build":
            return _cmd_build(args, glossary)
        if args.command == "translate":
            return _cmd_translate(args, glossary)
        if args.command == "glossary":
            return _cmd_glossary(args, glossary)
        if args.command == "docs":
            return _cmd_docs(args, glossary)
        if args.command == "serve":
            return _cmd_serve(args)
        if args.command == "status":
            return _cmd_status()
    except (BuildError, RuntimeError, ValueError) as exc:
        print(f"ผิดพลาด: {exc}", file=sys.stderr)
        return 1
    except FileNotFoundError as exc:
        print(f"ไม่พบไฟล์: {exc}", file=sys.stderr)
        return 1
    return 0


def _cmd_go(args, glossary: Glossary) -> int:
    from .auto import go_file, go_folder, go_text

    common = dict(
        work_root=WORK,
        out_root=OUT,
        glossary=glossary,
        engine=args.engine,
        effort=args.effort,
        bom=args.bom,
    )

    if args.source is None and args.ask_folder:
        args.source = _ask_path("พิมพ์ path โฟลเดอร์คอร์ส (หรือลากโฟลเดอร์มาวางที่นี่)")
        if args.source is None:
            return 1
        if not args.source.is_dir():
            print(f"ไม่ใช่โฟลเดอร์: {args.source}", file=sys.stderr)
            return 1

    if args.source is not None and args.source.is_dir():
        reports = go_folder(args.source, force=args.force, **common)
        if not reports:
            print("ไม่มีบทเรียนใหม่ให้ทำ")
            return 0
        print()
        print(f"เสร็จทั้งหมด {len(reports)} บทเรียน -> {OUT / args.source.name}")
        _open_folder(OUT / args.source.name, args.no_open)
        return 0

    if args.source is not None:
        report = go_file(
            source=args.source,
            course=args.course or args.source.parent.name,
            title=args.name or args.source.stem.replace("-", " "),
            **common,
        )
    else:
        from .clipboard import read

        text = read()
        line_count = len([ln for ln in text.split("\n") if ln.strip()])
        print(f"อ่านจาก clipboard: {line_count} บรรทัด")

        course = args.course or _ask("ชื่อคอร์ส", "my-course")
        title = args.name or _ask("ชื่อบทเรียน", "")
        report = go_text(text, course, title, courses_root=COURSES, **common)

    _print_report(report)
    _open_folder(report["out_dir"], args.no_open)
    return 0


def _clean_input(raw: str) -> str:
    """ตัดอักขระที่มองไม่เห็นออกจากสิ่งที่ผู้ใช้พิมพ์หรือวางมา

    BOM กับ zero-width space ติดมากับข้อความที่ก๊อปมาได้บ่อย และมันมองไม่เห็น
    ค่าที่ได้จึงดูเหมือนว่าง แต่ไม่ว่าง — ทำให้ค่าปริยายไม่ทำงาน และถ้าเอาไป
    ตั้งเป็นชื่อโฟลเดอร์ก็จะได้โฟลเดอร์ที่เปิดลำบาก
    """
    return raw.replace("﻿", "").replace("​", "").strip()


def _ask(label: str, default: str) -> str:
    suffix = f" [{default}]" if default else ""
    try:
        answer = _clean_input(input(f"{label}{suffix}: "))
    except EOFError:
        answer = ""
    return answer or default


def _ask_path(label: str) -> Path | None:
    """ถาม path จากผู้ใช้ — ลากไฟล์มาวางในหน้าต่าง console ก็ได้

    Windows ใส่ " ครอบให้เองเมื่อลากไฟล์ที่ path มีช่องว่าง ต้องถอดออกก่อน
    ไม่งั้นเครื่องหมายคำพูดจะกลายเป็นส่วนหนึ่งของชื่อไฟล์
    """
    print(label)
    try:
        answer = _clean_input(input("> "))
    except (EOFError, KeyboardInterrupt):
        answer = ""
    answer = _clean_input(answer.strip('"').strip("'"))
    if not answer:
        print("ไม่ได้ระบุ path — ยกเลิก", file=sys.stderr)
        return None
    return Path(answer)


def _print_report(report: dict) -> None:
    print()
    print(f"เสร็จแล้ว: {report['lesson']}")
    print(f"  แปล {report['translated']}/{report['total']} บรรทัด")
    if report["missing"]:
        print(f"  เตือน: ขาด {len(report['missing'])} บรรทัด (จะแสดงเป็นอังกฤษในไฟล์ซับ)")
    print(f"  ศัพท์ใหม่ {report['new_terms']} คำ")
    print(f"  ไฟล์: {report['out_dir']}")


def _open_folder(path, no_open: bool) -> None:
    if no_open:
        return
    try:
        import os

        os.startfile(path)  # Windows only; harmless if it fails
    except (AttributeError, OSError):
        pass


def _cmd_prepare(args, glossary: Glossary) -> int:
    written = prepare(
        source=args.source,
        work_root=WORK,
        glossary=glossary,
        course=args.course,
        title=args.title,
    )
    work_dir = written[0].parent
    print(f"เตรียมเสร็จ: {work_dir}")
    for path in written:
        print(f"  - {path.name}")
    print()
    print("ขั้นต่อไป — บอก Claude Code ว่า:")
    print(f'  "อ่าน {written[0].as_posix()} แล้วแปลตามที่ระบุในไฟล์"')
    print()
    print(f"เสร็จแล้วรัน: python -m udemy_th build {work_dir.as_posix()}")
    return 0


def _cmd_build(args, glossary: Glossary) -> int:
    report = build(args.work_dir, glossary, OUT, bom=args.bom)
    print(f"สร้างเสร็จ: {report['lesson']}")
    print(f"  แปลแล้ว {report['translated']}/{report['total']} บรรทัด")
    if report["missing"]:
        preview = ", ".join(str(i) for i in report["missing"][:10])
        more = "" if len(report["missing"]) <= 10 else f" (+{len(report['missing']) - 10})"
        print(f"  เตือน: ยังขาดบรรทัด {preview}{more}")
        print("         บรรทัดที่ขาดจะแสดงเป็นภาษาอังกฤษในไฟล์ซับ")
    print(f"  ศัพท์ในบทนี้ {report['seen_terms']} คำ (ใหม่ {report['new_terms']} คำ)")
    print(f"  ไฟล์ผลลัพธ์: {report['out_dir']}")
    return 0


def _cmd_translate(args, glossary: Glossary) -> int:
    if args.engine == "agy":
        from .translate_agy import translate

        written = translate(
            args.work_dir, glossary, effort=args.effort, model=args.model
        )
    else:
        from .translate_api import translate as translate_claude

        written = translate_claude(args.work_dir, glossary)

    for path in written:
        print(f"เขียนคำแปล: {path}")
    print(f"ขั้นต่อไป: python -m udemy_th build {Path(args.work_dir).as_posix()}")
    return 0


def _cmd_glossary(args, glossary: Glossary) -> int:
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(glossary.to_markdown(args.course), encoding="utf-8")
    print(f"ส่งออกคลังศัพท์ {len(glossary.terms)} คำ -> {args.out}")
    return 0


def _cmd_docs(args, glossary: Glossary) -> int:
    from .docs import translate_document, translate_folder

    out_root = OUT / "docs"
    if args.source is None:
        args.source = _ask_path("ลากไฟล์เอกสารมาวางที่นี่ หรือพิมพ์ path")
        if args.source is None:
            return 1

    if not args.source.exists():
        print(f"ไม่พบไฟล์หรือโฟลเดอร์: {args.source}", file=sys.stderr)
        return 1

    if args.source.is_dir():
        reports = translate_folder(
            args.source, glossary, out_root, args.engine, args.effort
        )
        if not reports:
            print("ไม่มีไฟล์ที่แปลสำเร็จ")
            return 1
        print()
        print(f"เสร็จ {len(reports)} ไฟล์")
        for report in reports:
            print(f"  {report['source']} -> {report['out'].name}")
        _open_folder(reports[0]["out"].parent, args.no_open)
        return 0

    report = translate_document(
        args.source, glossary, out_root, args.engine, args.effort
    )
    print(f"เสร็จแล้ว: {report['source']}")
    print(f"  แปล {report['translated']}/{report['blocks']} ย่อหน้า")
    print(f"  ศัพท์ใหม่ {report['new_terms']} คำ")
    print(f"  ไฟล์: {report['out']}")
    _open_folder(report["out"].parent, args.no_open)
    return 0


def _cmd_serve(args) -> int:
    from .server import serve

    serve(
        cache_dir=ROOT / "cache",
        glossary_path=GLOSSARY_PATH,
        engine=args.engine,
        effort=args.effort,
        port=args.port,
    )
    return 0


def _cmd_status() -> int:
    if not WORK.exists():
        print("ยังไม่มีบทเรียนที่เตรียมไว้ — เริ่มด้วย prepare")
        return 0

    rows: list[tuple[str, str]] = []
    for lesson_json in sorted(WORK.glob("*/*/lesson.json")):
        from .models import Lesson

        lesson = Lesson.load(lesson_json)
        total = len(lesson.segments)
        done = lesson.translated_count
        has_answer = any(lesson_json.parent.glob("translated*.md"))
        if done == total and total:
            state = "เสร็จแล้ว"
        elif done:
            state = f"แปลบางส่วน {done}/{total}"
        elif has_answer:
            state = "มีคำแปลแล้ว รอ build"
        else:
            state = "รอแปล"
        rows.append((f"{lesson.course}/{lesson.slug}", state))

    if not rows:
        print("ยังไม่มีบทเรียนที่เตรียมไว้ — เริ่มด้วย prepare")
        return 0

    width = max(len(name) for name, _ in rows)
    for name, state in rows:
        print(f"  {name.ljust(width)}  {state}")
    return 0
