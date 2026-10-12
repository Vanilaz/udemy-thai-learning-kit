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
  // After a seek, a sentence already this far under way is left to the
  // instructor: starting it from the top would say what is already past
  // (sentences run up to 14s) and push every following line late.
  const CATCH_UP_SECONDS = 1.5;
  const SOON_SECONDS = 3; // a line this close after a seek is worth waiting for
  // Slowest a line may be stretched to fill its sentence. Thai speech is
  // often shorter than the instructor's; at 1x it ended seconds early and,
  // with the instructor turned down, left silence while they still talked
  // (measured on a real lecture: 18.6s of 172s; 8.1s at this floor). Below
  // about 0.85 the stretch starts to sound slurred.
  const MIN_RATE = 0.85;

  /**
   * @param {object} deps
   * @param {HTMLMediaElement} deps.video
   * @param {ReturnType<UDTH.timeline.createTimeline>} deps.timeline
   * @param {object} deps.voice           see the header comment
   * @param {() => object} deps.settings  the current `dub` settings
   * @param {(sentenceId: string) => void} [deps.onDraft]  a draft text arrived
   * @param {(error: Error) => void} [deps.onIssue]        a line could not be voiced
   * @param {() => number} [deps.now]
   * @param {(...args: any[]) => void} [deps.debug]  diagnostic trace, off by default
   */
  function createDubber({ video, timeline, voice, settings, onDraft = () => {}, onIssue = () => {}, now = Date.now,
    debug = () => {} }) {
    let cursor = 0;
    let token = 0;
    let current = null; // { deadline, handle }
    let savedVolume = null;
    // The instructor stays down until here: the end of the slot of the last
    // sentence voiced (up to when the next one starts). A Thai line often
    // ends before the instructor's sentence does; the rest of it must not
    // pop up in English before the next line.
    let voicedUntil = -Infinity;
    let seeked = false; // a seek happened and no line has been said since
    // The player ran out of video (loading after a seek, a slow network): its
    // clock stands still while paused stays false, so a line started now
    // would run ahead of the picture by however long the loading takes.
    let stalled = false;
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
      voicedUntil = -Infinity;
      current = null;
    }

    // The first sentence to say from `time` after a seek: the one under way
    // if it has barely begun, otherwise the next one.
    function entryIndex(time) {
      const index = timeline.nextIndexAt(time);
      const sentence = timeline.sentences[index];
      return sentence && time > sentence.start + CATCH_UP_SECONDS ? index + 1 : index;
    }

    // A seek skips a sentence already well under way (see CATCH_UP_SECONDS).
    // Resuming after a pause says the interrupted sentence again instead:
    // the viewer heard its start a moment ago.
    function resync(afterSeek) {
      stop();
      cursor = afterSeek ? entryIndex(video.currentTime) : timeline.nextIndexAt(video.currentTime);
      debug("ตำแหน่งใหม่", Math.round(video.currentTime), "วินาที -> ประโยค", cursor);
    }

    // Turn the instructor down over the sentences the dub voices, and give
    // the volume back where it has nothing to say: the rest of a sentence
    // skipped after a seek, a dropped line, a stretch the AI has not
    // translated yet. Muting the instructor for the whole lecture turned
    // every such gap into silence.
    function duck() {
      const voicing = Boolean(current && current.handle) || video.currentTime < voicedUntil;
      if (settings().on && voicing) {
        if (savedVolume === null) savedVolume = video.volume;
        video.volume = settings().sourceVolume;
      } else if (savedVolume !== null) {
        video.volume = savedVolume;
        savedVolume = null;
      }
    }

    // How fast a clip must play: sped up to finish before the next sentence
    // is due, or slowed a little to last as long as the instructor speaks.
    // Watching at 1.5x shrinks the slot, so the video speed raises the cap too.
    function fitRate(seconds, sentence) {
      const speed = video.playbackRate || 1;
      const cap = settings().maxRate * speed;
      const remaining = (sentence.budgetEnd - video.currentTime) / speed;
      if (!(seconds > 0) || !(remaining > 0)) return cap;
      if (seconds >= remaining) return Math.min(cap, seconds / remaining);
      const speaking = (sentence.end - video.currentTime) / speed;
      if (!(speaking > seconds)) return 1;
      return Math.max(MIN_RATE, seconds / speaking);
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
        debug("ข้ามประโยค", sentence.index, "เสียงมาช้าเกินไป");
        current = null;
        tick();
        return;
      }
      debug("พากย์ประโยค", sentence.index, `${Math.round(sentence.start)}s`, plan.words.lang ? "จากต้นฉบับ" : "จากคำแปล AI",
        `ตอนวิดีโอ ${Math.round(video.currentTime)}s`);
      const handle = voice.speak(plan.words, {
        volume: settings().volume,
        fitRate: (seconds) => {
          const rate = fitRate(seconds, sentence);
          if (mine === token && current) current.deadline = now() + (seconds / rate + 5) * 1000;
          return rate;
        },
      });
      current.handle = handle;
      voicedUntil = sentence.budgetEnd;
      seeked = false;
      duck();
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
      if (!settings().on || video.paused || video.ended || stalled) return;
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

    const onSeeking = () => {
      seeked = true;
      resync(true);
    };
    const onPlay = () => {
      resync(seeked);
      tick();
    };
    const onWaiting = () => {
      stalled = true;
      stop();
    };
    const onPlaying = () => {
      if (!stalled) return; // the ordinary "playing" after "play": already handled
      stalled = false;
      resync(seeked);
      tick();
    };
    const listeners = {
      timeupdate: tick, pause: stop, seeking: onSeeking, play: onPlay, waiting: onWaiting, playing: onPlaying,
    };
    for (const [type, fn] of Object.entries(listeners)) video.addEventListener(type, fn);

    return {
      /**
       * Where the sentence under way at `time` began, when a seek landed well
       * into it (past CATCH_UP_SECONDS) and the dub has something to say for
       * it; null otherwise. Moving the video back there lets the dub say the
       * whole sentence instead of leaving its rest to the instructor.
       */
      lineStartAt(time) {
        const sentence = timeline.sentences[timeline.nextIndexAt(time)];
        if (!sentence || time <= sentence.start + CATCH_UP_SECONDS || !wordsFor(sentence)) return null;
        return sentence.start;
      },

      /**
       * Start getting the line due at `time` ready (after a seek). Resolves
       * once its audio is, failed or not; null when nothing is due soon, so
       * there is nothing worth waiting for.
       */
      prepareAt(time) {
        const sentence = timeline.sentences[entryIndex(time)];
        if (!sentence) return null;
        // Fetch now even when the line is some seconds off, so its audio is
        // there when it is due instead of leaving a silent gap then.
        prefetch(sentence.index);
        const plan = prepare(sentence);
        if (!plan || sentence.start - time > SOON_SECONDS) return null;
        return plan.ready.then(() => {}, () => {});
      },

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
