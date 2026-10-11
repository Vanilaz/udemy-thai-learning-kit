// The lecture as a list of sentences: the one model subtitles and dubbing read.
//
// Captions arrive as short display fragments, often cut mid-clause. They are
// merged into whole sentences once, from the original text, when the lecture
// loads. Sentences never move after that: translations and voice audio attach
// to a sentence by id. (Rebuilding the plan each time a translation chunk
// arrived shifted indices and cut off speech mid-sentence.)
//
// Each sentence can carry two Thai texts. `final` is the AI translation with
// the course glossary; it exists only once every fragment of the sentence is
// translated. `draft` is a fast provisional translation (Seamless) used until
// the final one arrives, and never after.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const SENTENCE_GAP_SECONDS = 1.2; // a pause this long is a sentence break
  const MAX_SENTENCE_SECONDS = 14; // a run-on passage is cut here
  const CAPTION_CHARS = 58; // two lines of Thai at the caption width
  const CAPTION_BRIDGE_SECONDS = 0.6; // hold a caption across a tiny pause

  const segmenter =
    typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("th", { granularity: "word" }) : null;

  function endsSentence(text) {
    return /[.!?。！？][")'\]]?\s*$/.test(text || "");
  }

  // Thai has no spaces between words; split on real word boundaries so a
  // caption chunk never cuts a word in half.
  function words(text) {
    if (!segmenter) return text.split(/(\s+)/).filter(Boolean);
    return [...segmenter.segment(text)].map((part) => part.segment);
  }

  function splitEvenly(parts, maxChars) {
    const total = parts.reduce((n, w) => n + w.length, 0);
    if (total <= maxChars) return [parts];
    const count = Math.ceil(total / maxChars);
    const target = total / count;
    const chunks = [];
    let current = [];
    let length = 0;
    for (const part of parts) {
      current.push(part);
      length += part.length;
      const soft = /\s$|[)\]]$/.test(part);
      if (chunks.length < count - 1 && (length >= target * 1.05 || (soft && length >= target * 0.85))) {
        chunks.push(current);
        current = [];
        length = 0;
      }
    }
    if (current.length) chunks.push(current);
    return chunks;
  }

  function groupIntoSentences(cues) {
    const groups = [];
    let current = null;
    cues.forEach((cue, index) => {
      const text = (cue.text || "").trim();
      if (!text) return;
      const breaks =
        current &&
        (cue.start - current.end > SENTENCE_GAP_SECONDS || cue.end - current.start > MAX_SENTENCE_SECONDS);
      if (breaks) {
        groups.push(current);
        current = null;
      }
      if (current) {
        current.end = cue.end;
        current.cueIndexes.push(index);
        current.source += " " + text;
      } else {
        current = { start: cue.start, end: cue.end, cueIndexes: [index], source: text };
      }
      if (endsSentence(text)) {
        groups.push(current);
        current = null;
      }
    });
    if (current) groups.push(current);
    return groups;
  }

  /**
   * @param {{start:number,end:number,text:string}[]} sourceCues  original-language captions
   * @param {{lang:string}} options  source language, e.g. "EN", "ES"
   */
  function createTimeline(sourceCues, { lang = "EN" } = {}) {
    const cueThai = sourceCues.map(() => "");
    const sentences = groupIntoSentences(sourceCues).map((group, index, all) => {
      const next = all[index + 1];
      return {
        id: `s${index}@${group.start.toFixed(2)}`,
        index,
        start: group.start,
        end: group.end,
        // The real budget for a sentence is until the next one has to start:
        // spending the instructor's pause keeps the dub from drifting behind.
        budgetEnd: next ? next.start : group.end + 3,
        source: group.source,
        cueIndexes: group.cueIndexes,
        final: null,
        draft: null,
        version: 0,
      };
    });
    const byId = new Map(sentences.map((s) => [s.id, s]));
    const chunkCache = new Map(); // sentence id -> { version, chunks }

    function displayText(sentence) {
      if (sentence.final) return { text: sentence.final, quality: "final" };
      if (sentence.draft) return { text: sentence.draft, quality: "draft" };
      return { text: sentence.source, quality: "source" };
    }

    function shownUntil(sentence) {
      const next = sentences[sentence.index + 1];
      return next && next.start - sentence.end <= CAPTION_BRIDGE_SECONDS ? next.start : sentence.end;
    }

    function chunksOf(sentence) {
      const cached = chunkCache.get(sentence.id);
      if (cached && cached.version === sentence.version) return cached.chunks;
      const { text, quality } = displayText(sentence);
      const pieces = splitEvenly(words(text), CAPTION_CHARS).map((p) => p.join("").trim());
      const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
      const end = shownUntil(sentence);
      const span = end - sentence.start;
      let at = sentence.start;
      const chunks = pieces.map((piece, i) => {
        const last = i === pieces.length - 1;
        const chunk = {
          text: piece,
          source: sentence.source,
          quality,
          start: at,
          end: last ? end : at + (span * piece.length) / total,
        };
        at = chunk.end;
        return chunk;
      });
      chunkCache.set(sentence.id, { version: sentence.version, chunks });
      return chunks;
    }

    function sentenceShownAt(time) {
      return sentences.find((s) => time >= s.start && time < shownUntil(s)) || null;
    }

    return {
      lang,
      sentences,

      /**
       * Merge server translation rows (one per source cue, `th` empty while
       * pending). Returns the ids of sentences that became final or changed.
       */
      applyTranslation(rows) {
        rows.forEach((row, i) => {
          if (i < cueThai.length && row && typeof row.th === "string" && row.th.trim()) {
            cueThai[i] = row.th.trim();
          }
        });
        const changed = [];
        for (const sentence of sentences) {
          const parts = sentence.cueIndexes.map((i) => cueThai[i]);
          const final = parts.every(Boolean) ? parts.join(" ") : null;
          if (final && final !== sentence.final) {
            sentence.final = final;
            sentence.version += 1;
            changed.push(sentence.id);
          }
        }
        return changed;
      },

      /** Provisional Thai for a sentence; ignored once the final text exists. */
      setDraft(id, text) {
        const sentence = byId.get(id);
        const clean = (text || "").trim();
        if (!sentence || sentence.final || !clean || clean === sentence.draft) return false;
        sentence.draft = clean;
        sentence.version += 1;
        return true;
      },

      /** What to show on screen at `time`, or null in a gap. */
      captionAt(time) {
        const sentence = sentenceShownAt(time);
        if (!sentence) return null;
        const chunks = chunksOf(sentence);
        return chunks.find((c) => time >= c.start && time < c.end) || chunks[chunks.length - 1];
      },

      /** Index of the first sentence that has not finished by `time`. */
      nextIndexAt(time) {
        const index = sentences.findIndex((s) => s.end > time);
        return index === -1 ? sentences.length : index;
      },

      /** Seconds of contiguous final translation from `time` onward. */
      finalCoverage(time) {
        let until = time;
        for (let i = 0; i < sourceCues.length; i += 1) {
          const cue = sourceCues[i];
          if (cue.end <= until) continue;
          if (!cueThai[i] || cue.start > until + 0.5) break;
          until = cue.end;
        }
        return Math.max(0, until - time);
      },

      /** True when everything from `time` to the end is translated. */
      translatedToEnd(time) {
        return sourceCues.every((cue, i) => cue.end <= time || Boolean(cueThai[i]));
      },
    };
  }

  UDTH.timeline = { createTimeline, endsSentence };
  if (typeof module !== "undefined") module.exports = UDTH.timeline;
})();
