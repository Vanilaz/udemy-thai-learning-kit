"use strict";
(() => {
  function parseTimedText(text) {
    const cues = [];
    const seconds = s => {
      const parts = s.replace(',', '.').split(':').map(Number);
      return parts.reduce((a, v) => a * 60 + v, 0);
    };
    for (const block of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
      const match = block.match(/(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})[^\n]*\n([\s\S]*)/);
      if (!match) continue;
      const start = seconds(match[1]), end = seconds(match[2]);
      const body = match[3].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (body && Number.isFinite(start) && end > start) cues.push({start, end, text: body});
    }
    return cues.sort((a, b) => a.start - b.start);
  }
  const storageKey = (course, lecture) => `udthTranscript:${JSON.stringify([course, lecture])}`;
  globalThis.UDTH = globalThis.UDTH || {};
  globalThis.UDTH.importedTranscript = {parseTimedText, storageKey};
  if (typeof module !== 'undefined') module.exports = globalThis.UDTH.importedTranscript;
})();
