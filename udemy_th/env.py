"""Read configuration from a `.env` file beside the project.

Windows environment variables are a bad place to keep this. `set` writes into
one Command Prompt and dies with it; `setx` writes permanently but only reaches
windows opened afterwards, so a server started from a window that was already
open sees nothing — and both failures look exactly like never having configured
anything at all. A file in the project has none of those modes: edit it, restart
the server, done.

Loaded from `udemy_th/__init__.py` so that it is in place before any module
computes a constant from `os.environ` at import time.

A real environment variable always wins over the file. That is the usual
convention, and it keeps `set UDTH_WORKERS=1 && start-server.cmd` working as a
one-off override without editing anything.
"""

from __future__ import annotations

import os
from pathlib import Path

# Project root: this file lives in udemy_th/, so one level up.
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"

# Names taken from the file, for the startup banner. Names only — a value
# here may well be an API key, and the console is the wrong place for one.
LOADED: list[str] = []


def parse(text: str) -> dict[str, str]:
    """Turn the contents of a .env file into name/value pairs.

    Deliberately small: `NAME=value`, `#` comments, blank lines, an optional
    `export ` prefix, and quotes around the value. No variable interpolation —
    a Windows path is full of backslashes and expanding anything inside one
    would corrupt it.
    """
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        name, separator, value = line.partition("=")
        if not separator:
            continue
        name = name.strip()
        if not name or not name.replace("_", "").isalnum():
            continue  # not a variable name; skip rather than guess

        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            # Quoted: take it exactly as written. A trailing comment cannot be
            # inside the quotes, and a path with spaces stays intact.
            value = value[1:-1]
        else:
            # Unquoted: an inline comment ends the value, but only when it is
            # spaced off — "#" occurs inside plenty of real values.
            marker = value.find(" #")
            if marker != -1:
                value = value[:marker].rstrip()
        values[name] = value
    return values


def load(path: Path | None = None) -> list[str]:
    """Apply the .env file to os.environ. Returns the names it actually set.

    Never raises: a missing file is the normal case, and a malformed one must
    not stop the server from starting with its defaults.
    """
    target = path or ENV_PATH
    try:
        # utf-8-sig: Notepad is what most people on Windows will edit this
        # with, and it writes a BOM that would otherwise become part of the
        # first variable's name.
        text = target.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return []

    applied = []
    for name, value in parse(text).items():
        if os.environ.get(name):
            continue  # a real environment variable outranks the file
        os.environ[name] = value
        applied.append(name)
    LOADED[:] = applied
    return applied
