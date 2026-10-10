"""Course-wide technical vocabulary.

This is the piece that makes translations *consistent*. Every term Claude
explains once gets stored here, and every later translation request is primed
with the terms it already knows — so "closure" is rendered the same way in
lecture 40 as it was in lecture 3, and you build a study vocabulary as a
side effect of watching the course.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .models import Term

# Words the translator sometimes files as "technical terms" although they come
# from the video player, the account UI or general business talk. They are not
# something a programmer needs to memorise.
NOT_TECHNICAL = frozenset({
    "speed", "subtitles", "transcripts", "roll back", "bookmark", "sign in", "sign up",
    "activation", "authorization request", "sensitivity analysis", "certification",
    "support plan", "aws support", "tutorial", "best practices", "rules",
    "troubleshooting", "blueprint",
})


def normalise_key(term: str) -> str:
    """Key under which `Array.from`, `Array.from()` and `array.froms` collide."""
    key = term.lower().strip()
    key = re.sub(r"\s*\(.*?\)\s*", " ", key).strip()
    key = re.sub(r"\s+", " ", key)
    if key.endswith("s") and len(key) > 4 and not key.endswith("ss"):
        key = key[:-1]
    return key


class Glossary:
    def __init__(self, path: Path):
        self.path = path
        self.terms: dict[str, Term] = {}
        if path.exists():
            self._load()

    def _load(self) -> None:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        for item in data.get("terms", []):
            term = Term(**item)
            self.terms[term.term.lower()] = term

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "terms": [
                {
                    "term": t.term,
                    "thai": t.thai,
                    "explanation": t.explanation,
                    "keep_english": t.keep_english,
                    "lessons": t.lessons,
                }
                for t in sorted(self.terms.values(), key=lambda t: t.term.lower())
            ]
        }
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def add(self, term: Term) -> bool:
        """Add a term, or merely record a new sighting of a known one.

        Returns True when the term was new.
        """
        key = term.term.lower()
        existing = self.terms.get(key)
        if existing:
            for lesson in term.lessons:
                if lesson not in existing.lessons:
                    existing.lessons.append(lesson)
            return False
        self.terms[key] = term
        return True

    def tidy(self) -> tuple[int, int]:
        """Merge near-duplicate entries and drop non-technical words.

        Returns (merged, dropped). Keeps the longest explanation, the cleanest
        (shortest, bracket-free) spelling as the display term, and the union of
        the lessons each variant appeared in.
        """
        groups: dict[str, list[Term]] = {}
        dropped = 0
        for term in self.terms.values():
            if term.term.lower().strip() in NOT_TECHNICAL:
                dropped += 1
                continue
            groups.setdefault(normalise_key(term.term), []).append(term)

        merged = 0
        result: dict[str, Term] = {}
        for variants in groups.values():
            best = max(variants, key=lambda t: (len(t.explanation), -len(t.term)))
            name = min((t.term for t in variants), key=lambda n: ("(" in n, len(n)))
            lessons: list[str] = []
            for variant in variants:
                for lesson in variant.lessons:
                    if lesson not in lessons:
                        lessons.append(lesson)
            merged += len(variants) - 1
            result[name.lower()] = Term(
                term=name,
                thai=best.thai,
                explanation=best.explanation,
                keep_english=best.keep_english,
                lessons=lessons,
            )
        self.terms = result
        return merged, dropped

    def relevant_to(self, text: str, limit: int = 60) -> list[Term]:
        """Terms that actually appear in `text`, most-seen first.

        Sending the whole glossary would waste tokens once it grows past a few
        hundred entries, so only prime the model with what this lesson uses.
        """
        haystack = text.lower()
        hits = [t for key, t in self.terms.items() if key in haystack]
        hits.sort(key=lambda t: (-len(t.lessons), t.term.lower()))
        return hits[:limit]

    def as_prompt_block(self, terms: list[Term]) -> str:
        """Render terms as instructions to reuse in a translation prompt."""
        if not terms:
            return "(ยังไม่มีศัพท์ในคลัง — นี่เป็นบทเรียนแรกที่แปล)"
        lines = []
        for t in terms:
            rule = "คงคำอังกฤษไว้" if t.keep_english else f"ใช้คำไทย: {t.thai}"
            lines.append(f"- {t.term} = {t.thai} ({rule})")
        return "\n".join(lines)

    def to_markdown(self, course: str = "") -> str:
        heading = f"# คลังศัพท์เทคนิค{f' — {course}' if course else ''}\n"
        if not self.terms:
            return heading + "\nยังไม่มีศัพท์ในคลัง\n"

        rows = [
            "",
            f"รวม **{len(self.terms)}** คำ",
            "",
            "| ศัพท์ | ความหมายไทย | คำอธิบาย | พบในบท |",
            "| --- | --- | --- | --- |",
        ]
        for t in sorted(self.terms.values(), key=lambda t: t.term.lower()):
            lessons = ", ".join(t.lessons[:5]) or "-"
            if len(t.lessons) > 5:
                lessons += f" (+{len(t.lessons) - 5})"
            explanation = t.explanation.replace("|", "\\|").replace("\n", " ")
            rows.append(f"| `{t.term}` | {t.thai} | {explanation} | {lessons} |")
        return heading + "\n".join(rows) + "\n"
