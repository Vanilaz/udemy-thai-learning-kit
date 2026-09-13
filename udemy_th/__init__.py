"""แปลบทเรียน Udemy เป็นไทย พร้อมสรุปบทเรียนและคลังศัพท์เทคนิค"""

__version__ = "0.1.0"

# Before anything else: several modules read os.environ while being imported
# (UDTH_WORKERS, UDTH_PARALLEL, UDTH_OMNIVOICE_MODEL), so the .env file has to
# be in place by the time the first of them is loaded.
from . import env as _env

ENV_LOADED = _env.load()
