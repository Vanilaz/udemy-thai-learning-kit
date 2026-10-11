"""One-shot installer behind install.cmd.

Lives in Python rather than in the .cmd file because cmd.exe cannot be trusted
with Thai text (see start-server.cmd), and every message here is for someone
who has never opened a terminal.

What it does, each step safe to re-run:
  1. creates .venv beside the project (start-server.cmd already prefers it)
  2. installs requirements.txt into it
  3. optionally installs the GPU voices, pinning torch/torchaudio as a pair
  4. creates .env from .env.example if there is none
  5. checks that a translator (agy or ANTHROPIC_API_KEY) is available
  6. opens the extension folder so it can be loaded into Chrome

Usage: python tools/install.py [--gpu | --no-gpu] [--yes]
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
TORCH_INDEX = os.environ.get("UDTH_TORCH_INDEX", "https://download.pytorch.org/whl/cu124")
MIN_PYTHON = (3, 10)


def say(text: str = "") -> None:
    print(text, flush=True)


def step(number: int, title: str) -> None:
    say()
    say(f"[{number}/6] {title}")
    say("-" * 58)


def fail(message: str) -> None:
    say()
    say("  ✗ " + message)
    say("  ติดตั้งไม่สำเร็จ — แก้ตามข้อความด้านบน แล้วดับเบิลคลิก install.cmd ใหม่ได้เลย")
    sys.exit(1)


def run(args: list[str], what: str) -> None:
    say(f"  > {what} ...")
    result = subprocess.run(args, cwd=ROOT)
    if result.returncode != 0:
        fail(f"{what} ไม่สำเร็จ (exit code {result.returncode})")


def ask(question: str, default: bool, assume_yes: bool) -> bool:
    if assume_yes:
        return default
    hint = "[Y/n]" if default else "[y/N]"
    try:
        answer = input(f"  {question} {hint} ").strip().lower()
    except EOFError:
        return default
    if not answer:
        return default
    return answer in ("y", "yes", "ใช่", "ช")


def suppress_error_dialogs() -> None:
    # Children inherit the error mode, so a mismatched native library in a
    # check below fails as text instead of a modal box nobody expects.
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x8000)
        except Exception:
            pass


def has_nvidia_gpu() -> bool:
    if not shutil.which("nvidia-smi"):
        return False
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    name = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
    if name:
        say(f"  พบการ์ดจอ: {name}")
    return bool(name)


def venv_python_check(code: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [str(VENV_PYTHON), "-c", code], cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )


def install_gpu() -> None:
    pip = [str(VENV_PYTHON), "-m", "pip", "install"]
    run(pip + ["torch", "torchaudio", "--index-url", TORCH_INDEX],
        "ติดตั้ง PyTorch รุ่น CUDA (ไฟล์ใหญ่ราว 3 GB ใช้เวลาสักพัก)")

    probe = venv_python_check(
        "import torch, torchaudio;"
        "print(torch.__version__.split('+')[0]);"
        "print(torchaudio.__version__.split('+')[0]);"
        "print(torch.cuda.is_available())"
    )
    if probe.returncode != 0:
        fail("PyTorch ติดตั้งแล้วแต่โหลดไม่ขึ้น:\n" + probe.stderr.strip()[-600:])
    torch_version, audio_version, cuda = probe.stdout.split()[:3]

    # Pin the pair so nothing below can drag in a torchaudio built for a
    # different torch — exactly how the "torch_library_impl" crash happened.
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as pins:
        pins.write(f"torch=={torch_version}\ntorchaudio=={audio_version}\n")
    try:
        run(pip + ["-r", "requirements-gpu.txt", "-c", pins.name],
            "ติดตั้งโมเดลเสียง AI (SeamlessM4T / OmniVoice)")
    finally:
        os.unlink(pins.name)

    check = venv_python_check("import torch, torchaudio, omnivoice, transformers")
    if check.returncode != 0:
        fail("ติดตั้งเสียง GPU แล้วแต่โหลดไม่ขึ้น:\n" + check.stderr.strip()[-600:])
    say(f"  ✓ torch {torch_version} + torchaudio {audio_version} — CUDA ใช้งานได้: {cuda}")
    if cuda != "True":
        say("  ! ไม่เห็น CUDA — เสียง GPU จะช้ามาก ลองอัปเดตไดรเวอร์การ์ดจอ NVIDIA")


def find_agy() -> str | None:
    found = shutil.which("agy")
    if found:
        return found
    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidate = Path(local) / "agy" / "bin" / "agy.exe"
        if candidate.exists():
            return str(candidate)
    return None


def env_has(name: str) -> bool:
    if os.environ.get(name):
        return True
    env = ROOT / ".env"
    if not env.is_file():
        return False
    for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
        key, _, value = line.strip().partition("=")
        if key.strip() == name and value.strip():
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--gpu", action="store_true", help="install GPU voices without asking")
    group.add_argument("--no-gpu", action="store_true", help="skip GPU voices")
    parser.add_argument("--yes", action="store_true", help="accept defaults, ask nothing")
    args = parser.parse_args()

    suppress_error_dialogs()
    say("=" * 58)
    say("  ฮองเรียน (HongRian) — ติดตั้งอัตโนมัติ")
    say("=" * 58)

    step(1, "ตรวจ Python")
    if sys.version_info < MIN_PYTHON:
        fail(f"ต้องใช้ Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} ขึ้นไป (ตอนนี้ {sys.version.split()[0]})")
    say(f"  ✓ Python {sys.version.split()[0]}")

    step(2, "เตรียมพื้นที่ติดตั้ง (.venv)")
    if VENV_PYTHON.exists():
        say("  ✓ มี .venv อยู่แล้ว ใช้ของเดิม")
    else:
        run([sys.executable, "-m", "venv", str(VENV)], "สร้าง .venv")
    run([str(VENV_PYTHON), "-m", "pip", "install", "--upgrade", "pip", "-q"], "อัปเดต pip")
    run([str(VENV_PYTHON), "-m", "pip", "install", "-r", "requirements.txt"],
        "ติดตั้งแพ็กเกจหลัก (เสียงพากย์ Edge / Google)")
    if venv_python_check("import edge_tts").returncode != 0:
        fail("ติดตั้ง edge-tts แล้วแต่โหลดไม่ขึ้น")
    say("  ✓ แพ็กเกจหลักพร้อม")

    step(3, "เสียงพากย์ AI บนการ์ดจอ (ไม่บังคับ)")
    if args.no_gpu:
        say("  ข้าม (--no-gpu)")
    elif not has_nvidia_gpu():
        say("  ไม่พบการ์ดจอ NVIDIA — ข้าม (เสียง Edge ฟรีไม่จำกัดใช้ได้ปกติ)")
    elif args.gpu or ask("ติดตั้งเสียง AI บนการ์ดจอด้วยไหม? ดาวน์โหลดราว 3-5 GB", False, args.yes):
        install_gpu()
    else:
        say("  ข้าม — ติดตั้งทีหลังได้ด้วย install.cmd --gpu")

    step(4, "ไฟล์ตั้งค่า .env")
    env, example = ROOT / ".env", ROOT / ".env.example"
    if env.exists():
        say("  ✓ มี .env อยู่แล้ว ไม่แตะของเดิม")
    elif example.exists():
        shutil.copyfile(example, env)
        say("  ✓ สร้าง .env จาก .env.example แล้ว (แก้ทีหลังได้ ไม่จำเป็นต้องแก้)")

    step(5, "ตรวจตัวแปลภาษา")
    agy = find_agy()
    translator_ok = True
    if agy:
        say(f"  ✓ พบ Antigravity CLI: {agy}")
    elif env_has("ANTHROPIC_API_KEY"):
        say("  ✓ พบ ANTHROPIC_API_KEY — เปิดเซิร์ฟเวอร์ด้วย engine claude")
    else:
        translator_ok = False
        say("  ! ยังไม่มีตัวแปล — ซับไทยจะยังแปลไม่ได้จนกว่าจะทำอย่างใดอย่างหนึ่ง:")
        say("      ก) ติดตั้ง Antigravity จาก https://antigravity.google แล้วล็อกอิน")
        say("      ข) ใส่ ANTHROPIC_API_KEY=... ในไฟล์ .env")

    step(6, "ติดตั้ง Extension เข้า Chrome / Edge")
    extension = ROOT / "extension"
    say("  ทำเองครั้งเดียว (ระบบเปิดโฟลเดอร์ extension ให้แล้ว):")
    say("    1. เปิด chrome://extensions  (Edge: edge://extensions)")
    say("    2. เปิดสวิตช์ Developer mode")
    say("    3. กด Load unpacked แล้วเลือกโฟลเดอร์นี้:")
    say(f"       {extension}")
    if os.name == "nt" and not args.yes:
        subprocess.run(["explorer", str(extension)])

    say()
    say("=" * 58)
    say("  ✓ ติดตั้งเสร็จ" + ("" if translator_ok else " (ยังต้องตั้งตัวแปลตามข้อ 5)"))
    say("  ทุกครั้งที่จะเรียน: ดับเบิลคลิก start-server.cmd แล้วเปิดวิดีโอได้เลย")
    say("=" * 58)
    return 0


if __name__ == "__main__":
    sys.exit(main())
