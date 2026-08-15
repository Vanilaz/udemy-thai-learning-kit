"""Core data structures shared across the pipeline."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path


@dataclass
class Segment:
    """One caption line from a lesson transcript."""

    id: int
    text: str
    start: float | None = None
    end: float | None = None
    thai: str | None = None

    @property
    def has_timing(self) -> bool:
        return self.start is not None and self.end is not None


@dataclass
class Lesson:
    """A single Udemy lecture: its segments plus everything derived from them."""

    slug: str
    title: str
    course: str = ""
    segments: list[Segment] = field(default_factory=list)
    summary: str = ""
    key_points: list[str] = field(default_factory=list)

    @property
    def source_text(self) -> str:
        return "\n".join(s.text for s in self.segments)

    @property
    def translated_count(self) -> int:
        return sum(1 for s in self.segments if s.thai)

    def to_json(self) -> str:
        payload = {
            "slug": self.slug,
            "title": self.title,
            "course": self.course,
            "summary": self.summary,
            "key_points": self.key_points,
            "segments": [asdict(s) for s in self.segments],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: Path) -> "Lesson":
        data = json.loads(path.read_text(encoding="utf-8"))
        lesson = cls(
            slug=data["slug"],
            title=data["title"],
            course=data.get("course", ""),
            summary=data.get("summary", ""),
            key_points=data.get("key_points", []),
        )
        lesson.segments = [Segment(**s) for s in data["segments"]]
        return lesson

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.to_json(), encoding="utf-8")


@dataclass
class Term:
    """A technical term worth remembering across the whole course."""

    term: str
    thai: str
    explanation: str
    # Keep the term in English inside Thai prose (e.g. "async", "closure")
    # instead of substituting the Thai gloss.
    keep_english: bool = True
    lessons: list[str] = field(default_factory=list)
