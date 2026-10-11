"""แปลบทเรียน Udemy เป็นไทย พร้อมสรุปบทเรียนและคลังศัพท์เทคนิค"""

import json as _json
from pathlib import Path as _Path


def _read_version() -> str:
    # One version for the whole project: the extension's manifest. The server
    # reports it on /health so the extension can tell when the two drift.
    try:
        manifest = _Path(__file__).resolve().parent.parent / "extension" / "manifest.json"
        return _json.loads(manifest.read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return "0.0.0"


__version__ = _read_version()

# Before anything else: several modules read os.environ while being imported
# (UDTH_WORKERS, UDTH_PARALLEL, UDTH_OMNIVOICE_MODEL), so the .env file has to
# be in place by the time the first of them is loaded.
from . import env as _env

ENV_LOADED = _env.load()
