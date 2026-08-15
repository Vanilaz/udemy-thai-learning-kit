"""Read the Windows clipboard without adding a dependency.

The whole point of this module is to remove a step: you select the transcript
in Udemy, press Ctrl+C, and run the tool. No saving a .txt by hand.
"""

from __future__ import annotations

import subprocess


class ClipboardError(RuntimeError):
    pass


def read() -> str:
    """Return clipboard text, or raise ClipboardError with a readable message."""
    try:
        result = subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-Clipboard -Raw",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
    except FileNotFoundError as exc:
        raise ClipboardError(
            "อ่าน clipboard ได้เฉพาะบน Windows — ให้บันทึก transcript เป็นไฟล์ .txt แล้วระบุ path แทน"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ClipboardError("อ่าน clipboard ไม่สำเร็จ (timeout)") from exc

    if result.returncode != 0:
        detail = (result.stderr or "").strip()[:200]
        raise ClipboardError(f"อ่าน clipboard ไม่สำเร็จ: {detail}")

    text = (result.stdout or "").strip()
    if not text:
        raise ClipboardError(
            "clipboard ว่าง — ไปที่วิดีโอ Udemy กดปุ่ม Transcript "
            "เลือกข้อความทั้งหมด แล้วกด Ctrl+C ก่อน"
        )
    return text
