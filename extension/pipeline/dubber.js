// Speaks the timeline's sentences in Thai, in step with the video.
//
// The dubber owns timing only: which sentence to say, when, and what to do
// when the video seeks, pauses or outruns the voice. How a sentence becomes
// sound belongs to the voice it is given:
//
//   voice.canTranslate        true if it can speak Thai from the original text
//   voice.prepare(words)      fetch/decode ahead of time; may return {spokenText}
//   voice.speak(words, opts)  start speaking; returns {done: Promise, stop()}
//                             opts.fitRate(seconds) -> playback rate to use
//
// `words` is {text, lang}: lang is null for Thai text, or the source language
// when the voice must translate on the way (the draft path).
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const PREFETCH_AHEAD = 4; // sentences prepared beyond the current one
  const LATE_TOLERANCE = 2.5; // seconds past its end before a line is dropped
  const START_LEAD = 0.25; // start this early: timeupdate fires ~4x a second
  const STUCK_MS = 45000; // ceiling before a line has reported its length

  /**
   * @param {object} deps
   * @param {HTMLMediaElement} deps.video
   * @param {ReturnType<UDTH.timeline.createTimeline>} deps.timeline
   * @param {object} deps.voice           see the header comment
   * @param {() => object} deps.settings  the current `dub` settings
   * @param {(sentenceId: string) => void} [deps.onDraft]  a draft text arrived
   * @param {(error: Error) => void} [deps.onIssue]        a line could not be voiced
   * @param {() => number} [deps.now]
   */
  function createDubber({ video, timeline, voice, settings, onDraft = () => {}, onIssue = () => {}, now = Date.now }) {
    let cursor = 0;
    let token = 0;
    let current = null; // { deadline, handle }
    let savedVolume = null;
    const prepared = new Map(); // words key -> Promise

    function wordsFor(sentence) {
      if (sentence.final) return { text: sentence.final, lang: null };
      if (settings().start === "instant" && voice.canTranslate) {
        return { text: sentence.source, lang: timeline.lang.toLowerCase() };
      }
      return null; // nothing trustworthy to say yet
    }

    function prepare(sentence) {
      const words = wordsFor(sentence);
      if (!words) return null;
      const key = `${words.lang || "th"}|${words.text}`;
      if (!prepared.has(key)) {
        const ready = Promise.resolve(voice.prepare(words)).then((result) => {
          if (words.lang && result && result.spokenText && timeline.setDraft(sentence.id, result.spokenText)) {
            onDraft(sentence.id);
          }
          return result;
        });
        // A failed request may succeed later (server restarted, model loaded).
        ready.catch(() => prepared.delete(key));
        prepared.set(key, ready);
      }
      return { words, ready: prepared.get(key) };
    }

    function prefetch(from) {
      const list = timeline.sentences;
      for (let i = from; i < Math.min(list.length, from + 1 + PREFETCH_AHEAD); i += 1) {
        const plan = prepare(list[i]);
        if (plan) plan.ready.catch(() => {});
      }
    }

    function stop() {
      token += 1; // every pending callback of the old line becomes inert
      if (current && current.handle) current.handle.stop();
      current = null;
    }

    function resync() {
      stop();
      cursor = timeline.nextIndexAt(video.currentTime);
    }

    // Turn the instructor down while dubbing; give the volume back after.
    function duck() {
      if (settings().on) {
        if (savedVolume === null) savedVolume = video.volume;
        video.volume = settings().sourceVolume;
      } else if (savedVolume !== null) {
        video.volume = savedVolume;
        savedVolume = null;
      }
    }

    // How fast a clip must play to finish before the next sentence is due.
    // Watching at 1.5x shrinks the slot, so the video speed raises the cap too.
    function fitRate(seconds, sentence) {
      const speed = video.playbackRate || 1;
      const cap = settings().maxRate * speed;
      const remaining = (sentence.budgetEnd - video.currentTime) / speed;
      if (!(seconds > 0) || !(remaining > 0)) return cap;
      return Math.max(1, Math.min(cap, seconds / remaining));
    }

    async function speak(sentence, plan) {
      const mine = (token += 1);
      current = { deadline: now() + STUCK_MS, handle: null };
      try {
        await plan.ready;
      } catch (error) {
        if (mine !== token) return;
        current = null;
        onIssue(error);
        return;
      }
      if (mine !== token) return;
      // Synthesis took so long the instructor has moved on: saying it now
      // would talk over the next sentence.
      if (video.currentTime > sentence.end + LATE_TOLERANCE) {
        current = null;
        tick();
        return;
      }
      const handle = voice.speak(plan.words, {
        volume: settings().volume,
        fitRate: (seconds) => {
          const rate = fitRate(seconds, sentence);
          if (mine === token && current) current.deadline = now() + (seconds / rate + 5) * 1000;
          return rate;
        },
      });
      current.handle = handle;
      try {
        await handle.done;
      } catch (error) {
        if (mine === token) onIssue(error);
      }
      if (mine !== token) return;
      current = null;
      tick();
    }

    function tick() {
      duck();
      if (!settings().on || video.paused || video.ended) return;
      if (current) {
        if (now() < current.deadline) return;
        stop(); // a clip that never reported its end must not silence the rest
      }
      const time = video.currentTime;
      const list = timeline.sentences;
      while (cursor < list.length && time > list[cursor].end + LATE_TOLERANCE) cursor += 1;
      const sentence = list[cursor];
      if (!sentence || time < sentence.start - START_LEAD) return;
      cursor += 1;
      prefetch(sentence.index);
      const plan = prepare(sentence);
      if (plan) speak(sentence, plan);
      else tick(); // nothing to say for this one; consider the next
    }

    const onPlay = () => {
      resync();
      tick();
    };
    const listeners = { timeupdate: tick, pause: stop, seeking: resync, play: onPlay };
    for (const [type, fn] of Object.entries(listeners)) video.addEventListener(type, fn);

    return {
      /** Settings or translations changed: re-apply and carry on. */
      refresh() {
        if (!settings().on) stop();
        tick();
      },
      dispose() {
        stop();
        for (const [type, fn] of Object.entries(listeners)) video.removeEventListener(type, fn);
        if (savedVolume !== null) video.volume = savedVolume;
        savedVolume = null;
      },
    };
  }

  UDTH.dubber = { createDubber };
  if (typeof module !== "undefined") module.exports = UDTH.dubber;
})();
