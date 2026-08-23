"""Translate through the Antigravity CLI (`agy`) — no API key needed.

Design note: `agy -p` takes the prompt as a command-line argument and does not
read stdin, and Windows caps a whole command line at 32,767 characters. So the
prompt is packed to fit that budget rather than split by a fixed line count,
and the transcript is passed in the argument instead of on disk. That keeps
`agy` from needing file-tool permissions at all — it only ever prints to
stdout, and this module writes the files.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .glossary import Glossary
from .models import Lesson, Segment
from .prompts import DOC_OUTPUT_FORMAT, DOC_RULES, OUTPUT_FORMAT, RULES, SYSTEM

# Windows CreateProcess caps the command line at 32,767 characters. Leave room
# for the executable path and the other flags.
SAFE_PROMPT_CHARS = 24_000
# `agy` gives a print-mode run 5 minutes by default; long lessons need more.
PRINT_TIMEOUT = "15m"
TIMEOUT_SECONDS = 1200

# How many chunks of one lesson may be translated at the same time.
#
# Each is a separate `agy` process, so this trades memory and provider rate
# limit against wall time. Three is enough to hide most of the latency without
# making a laptop unusable; set UDTH_PARALLEL=1 to go back to one at a time.
MAX_PARALLEL_CHUNKS = max(1, int(os.environ.get("UDTH_PARALLEL", "3")))

_PROMPT_TEMPLATE = """\
{system}

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

ตอบกลับมาเป็นข้อความล้วนตามรูปแบบข้างบนเท่านั้น ห้ามสร้างไฟล์ ห้ามรันคำสั่ง
ห้ามใส่คำทักทายหรือคำอธิบายเพิ่ม เริ่มคำตอบด้วย `## SUBTITLES` ทันที
"""


class AgyNotFound(RuntimeError):
    pass


def find_agy() -> str:
    """Locate agy.exe — PATH first, then the default Windows install dir."""
    found = shutil.which("agy")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "agy" / "bin" / "agy.exe"
        if candidate.exists():
            return str(candidate)
    raise AgyNotFound(
        "ไม่พบ agy CLI — ติดตั้ง Antigravity แล้วรัน `agy install` "
        "เพื่อเพิ่มลง PATH หรือใช้ --engine claude แทน"
    )


def translate_text(
    lesson: Lesson,
    glossary: Glossary,
    effort: str = "high",
    model: str | None = None,
    on_progress: Callable[[int, int], None] | None = None,
    mode: str = "subtitle",
    on_chunk: Callable[[int, str], None] | None = None,
) -> list[str]:
    """Translate a Lesson in memory; return each chunk's raw answer text.

    `on_chunk(index, answer)` fires the moment each chunk comes back, so the
    caller can publish a partial translation instead of making the viewer wait
    for the whole lecture.

    `mode` picks the rule set: "subtitle" for caption lines, "doc" for article
    and handout prose (where code blocks must survive untranslated).
    Used directly by the local server. `translate()` wraps this for the CLI.
    """
    agy = find_agy()
    glossary_block = glossary.as_prompt_block(glossary.relevant_to(lesson.source_text))
    chunks = _pack(lesson, glossary_block, mode)

    # Chunks are independent: each is rendered with the same glossary block and
    # answers with its own line ids, and nothing is written to disk until every
    # chunk is back. Running them one after another meant a four-chunk lecture
    # took four times as long for no reason — the wait was process startup and
    # model latency repeated, not work that had to be ordered.
    #
    # Whole *lectures* still run one at a time (see server.py): that queue
    # exists to stop a batch spawning a dozen agy processes and to keep the
    # shared glossary file from being written concurrently. Neither applies
    # inside a single lecture.
    if len(chunks) > 1 and MAX_PARALLEL_CHUNKS > 1:
        return _translate_parallel(
            agy, lesson, chunks, glossary_block, effort, model, on_progress, mode, on_chunk
        )

    answers: list[str] = []
    for index, chunk in enumerate(chunks, start=1):
        label = f"[{index}/{len(chunks)}] บรรทัด {chunk[0].id}-{chunk[-1].id}"
        print(f"  {label} — กำลังแปลด้วย agy ...", flush=True)
        answer = _run_chunk(agy, lesson, chunk, glossary_block, effort, model, mode, label)
        answers.append(answer)
        if on_chunk:
            on_chunk(index - 1, answer)
        if on_progress:
            on_progress(index, len(chunks))

    return answers


def _run_chunk(
    agy: str,
    lesson: Lesson,
    chunk: list[Segment],
    glossary_block: str,
    effort: str,
    model: str | None,
    mode: str,
    label: str,
) -> str:
    """One agy invocation. Shared by the serial and parallel paths."""
    command = [
        agy,
        "-p",
        _render(lesson, chunk, glossary_block, mode),
        "--output-format",
        "text",
        "--effort",
        effort,
        # Transcript lines can start with "/" and would otherwise be expanded
        # as slash commands.
        "--disable-slash-commands",
        "--print-timeout",
        PRINT_TIMEOUT,
    ]
    if model:
        command += ["--model", model]

    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"agy ใช้เวลานานเกิน {TIMEOUT_SECONDS} วินาที ที่ {label}") from exc

    output = (result.stdout or "").strip()
    if result.returncode != 0:
        detail = (result.stderr or "").strip() or output
        raise RuntimeError(f"agy ล้มเหลว (exit {result.returncode}): {detail[:500]}")
    if "## SUBTITLES" not in output:
        detail = output[:400] or (result.stderr or "").strip()[:400]
        raise RuntimeError(
            f"agy ตอบไม่ตรงรูปแบบที่ {label} — ไม่พบหัวข้อ '## SUBTITLES'\n{detail}"
        )
    return output


def _translate_parallel(
    agy: str,
    lesson: Lesson,
    chunks: list[list[Segment]],
    glossary_block: str,
    effort: str,
    model: str | None,
    on_progress: Callable[[int, int], None] | None,
    mode: str,
    on_chunk: Callable[[int, str], None] | None = None,
) -> list[str]:
    workers = min(MAX_PARALLEL_CHUNKS, len(chunks))
    print(f"  แปล {len(chunks)} ช่วงพร้อมกัน {workers} ตัว ...", flush=True)

    answers: list[str | None] = [None] * len(chunks)
    done = 0
    lock = threading.Lock()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(
                _run_chunk,
                agy,
                lesson,
                chunk,
                glossary_block,
                effort,
                model,
                mode,
                f"[{i + 1}/{len(chunks)}] บรรทัด {chunk[0].id}-{chunk[-1].id}",
            ): i
            for i, chunk in enumerate(chunks)
        }
        for future in as_completed(futures):
            index = futures[future]
            # Let the first failure propagate: a lecture missing a chunk is not
            # a partial success, and the caller reports it to the extension.
            answers[index] = future.result()
            with lock:
                if on_chunk:
                    on_chunk(index, answers[index])
                done += 1
                print(f"  เสร็จ {done}/{len(chunks)} ช่วง", flush=True)
                if on_progress:
                    on_progress(done, len(chunks))

    return [a for a in answers if a is not None]


def translate(
    work_dir: Path,
    glossary: Glossary,
    effort: str = "high",
    model: str | None = None,
) -> list[Path]:
    """Translate a prepared lesson with agy; write translated*.md files."""
    lesson_path = work_dir / "lesson.json"
    if not lesson_path.exists():
        raise RuntimeError(f"ไม่พบ {lesson_path} — รัน prepare ก่อน")
    lesson = Lesson.load(lesson_path)

    answers = translate_text(lesson, glossary, effort=effort, model=model)

    written: list[Path] = []
    for index, answer in enumerate(answers, start=1):
        suffix = "" if len(answers) == 1 else f"-part{index:02d}"
        answer_path = work_dir / f"translated{suffix}.md"
        answer_path.write_text(answer, encoding="utf-8")
        written.append(answer_path)
    return written


def _render(
    lesson: Lesson, chunk: list[Segment], glossary_block: str, mode: str = "subtitle"
) -> str:
    rules = DOC_RULES if mode == "doc" else RULES
    fmt = DOC_OUTPUT_FORMAT if mode == "doc" else OUTPUT_FORMAT
    return _PROMPT_TEMPLATE.format(
        system=SYSTEM,
        rules=rules,
        glossary_block=glossary_block,
        title=lesson.title,
        body="\n".join(f"[[{s.id}]] {s.text}" for s in chunk),
        output_format=fmt.format(first_id=chunk[0].id, last_id=chunk[-1].id),
    )


def _pack(
    lesson: Lesson, glossary_block: str, mode: str = "subtitle"
) -> list[list[Segment]]:
    """Group segments so each rendered prompt stays under the arg-size budget."""
    overhead = len(_render(lesson, lesson.segments[:1], glossary_block, mode))
    budget = SAFE_PROMPT_CHARS - overhead
    if budget <= 0:
        raise RuntimeError(
            "คลังศัพท์หรือคำสั่งยาวเกินไปจนไม่เหลือที่ให้ transcript — "
            "ลดจำนวนคำในคลังศัพท์ หรือใช้ --engine claude"
        )

    chunks: list[list[Segment]] = []
    current: list[Segment] = []
    size = 0
    for segment in lesson.segments:
        # "[[123]] " plus the text plus a newline.
        cost = len(segment.text) + len(str(segment.id)) + 8
        if current and size + cost > budget:
            chunks.append(current)
            current, size = [], 0
        current.append(segment)
        size += cost
    if current:
        chunks.append(current)
    return chunks
