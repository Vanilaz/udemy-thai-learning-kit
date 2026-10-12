// One lecture, from its captions to a playing, subtitled, dubbed video.
//
// The session is a small state machine and the only place that decides
// whether the video may play:
//
//   loading -> unavailable {reason} | error {message}
//           -> waiting {waitingFor: {translation?, voice?, speech?}} -> playing {translating, notice?}
//
// It holds the video while anything in `waitingFor` is outstanding, and lets
// it go the moment nothing is (or the user skips). The views render whatever
// state it publishes; they never decide on their own.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});
  const { createTimeline } = UDTH.timeline || require("../core/timeline.js");
  const { createDubber } = UDTH.dubber || require("./dubber.js");
  const { t } = UDTH.i18n || require("../core/i18n.js");

  // How much translated runway is enough to hand the player back. Chunks land
  // out of order, so what matters is whether the stretch the viewer is about
  // to watch is covered, not how many chunks are done.
  const READY_AHEAD_SECONDS = 90;
  // After a seek, the dub's next line usually has its audio within a second
  // or two. The video is held for it (with the waiting card) rather than
  // playing on in silence, but only when it is not ready almost at once, so
  // a quick answer does not flash the card, and never for long.
  const SPEECH_HOLD_AFTER_MS = 150;
  const SPEECH_WAIT_MAX_MS = 8000;

  /**
   * @param {object} deps
   * @param {object} deps.site         title(), cacheScope(), cacheId(), transcript()
   * @param {HTMLMediaElement} deps.video
   * @param {object} deps.api          core/api.js client
   * @param {object} deps.settings     core/settings.js store (get, subscribe)
   * @param {(dub: object, engines: object[]) => object} deps.makeVoice
   * @param {(state: object) => void} deps.onState
   */
  function createSession({
    site, video, api, settings, makeVoice, onState,
    takeForce = async () => false,
    pollMs = 1500,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    log = () => {},
    debug = () => {},
  }) {
    let disposed = false;
    let phase = "loading";
    let waitingFor = {};
    let translating = null;
    let notice = "";
    let skipped = false;
    let timeline = null;
    let dubber = null;
    let voice = null;
    let engines = [];
    let voiceLoading = false;
    let voiceToken = 0;
    let unsubscribe = () => {};
    let jobId = null;
    let seekHeld = false; // waiting again because the viewer jumped past the translation
    let catchingUp = false; // waiting for the dub's audio at the spot the viewer jumped to
    let seekToken = 0;
    let snappedTo = null; // where we last moved the video ourselves
    const hold = { active: false, wasPlaying: false, onPlay: null };

    const dub = () => settings.get().dub;

    function emit(state) {
      if (!disposed) onState(state);
    }

    function publish() {
      if (phase === "waiting") emit({ phase, waitingFor: { ...waitingFor } });
      else if (phase === "playing") emit({ phase, translating, ...(notice ? { notice } : {}) });
    }

    // Pausing once is not enough: the player, and the user, can both start
    // playback again while we wait. Remember whether it was playing so the
    // lecture is handed back in the state the user left it in.
    function holdVideo() {
      if (hold.active) return;
      hold.active = true;
      hold.wasPlaying = !video.paused;
      hold.onPlay = () => {
        hold.wasPlaying = true;
        video.pause();
      };
      video.addEventListener("play", hold.onPlay);
      video.pause();
    }

    function releaseVideo(resume = true) {
      if (!hold.active) return;
      video.removeEventListener("play", hold.onPlay);
      hold.active = false;
      if (resume && hold.wasPlaying) {
        const played = video.play();
        if (played && played.catch) played.catch(() => {});
      }
    }

    // Playing straight away is possible only when the dub can produce Thai
    // from the original itself; otherwise the subtitles need the AI first.
    function instant() {
      const d = dub();
      return Boolean(d.on && d.start === "instant" && voice && voice.canTranslate);
    }

    function evaluate() {
      if (disposed || phase !== "waiting") return;
      const now = video.currentTime || 0;
      const reasons = {};
      const covered = timeline.finalCoverage(now);
      if (!instant() && covered < READY_AHEAD_SECONDS && !timeline.translatedToEnd(now)) {
        reasons.translation = {
          readySeconds: Math.round(covered),
          neededSeconds: READY_AHEAD_SECONDS,
          ...(translating || { done: 0, total: 0 }),
          ...(seekHeld ? { seeked: true } : {}),
        };
      }
      if (dub().on && voiceLoading) reasons.voice = { engine: dub().engine };
      if (catchingUp && dub().on) reasons.speech = {};
      if (skipped || !Object.keys(reasons).length) {
        phase = "playing";
        waitingFor = {};
        seekHeld = false;
        catchingUp = false;
        releaseVideo();
        publish();
        if (dubber) dubber.refresh();
        return;
      }
      waitingFor = reasons;
      holdVideo();
      publish();
    }

    function changed() {
      if (phase === "waiting") evaluate();
      else publish();
      if (dubber) dubber.refresh();
    }

    // Local models need loading onto the GPU first. Ask the server to start
    // and keep asking until it is done; hosted engines answer "none" at once.
    // Resolves after the first answer, so nothing is held (or released) on a
    // guess: holding the video for a voice that needs no loading made it stutter.
    function watchVoice() {
      const mine = (voiceToken += 1);
      const d = dub();
      if (!d.on || d.engine === "windows") {
        voiceLoading = false;
        return Promise.resolve();
      }
      const ask = async () => {
        try {
          return await api.warmup(d.engine);
        } catch (error) {
          return { state: "none" }; // unreachable: synthesis reports it in context
        }
      };
      const apply = (reply) => {
        voiceLoading = reply.state === "loading" || reply.state === "idle";
        if (reply.state === "error") notice = t("โหลดเสียง {engine} ไม่สำเร็จ: {reason}", { engine: d.engine, reason: reply.error || "" }).trim();
      };
      const first = ask().then((reply) => {
        if (!disposed && mine === voiceToken) apply(reply);
      });
      first.then(async () => {
        while (!disposed && mine === voiceToken && voiceLoading) {
          await sleep(pollMs);
          const reply = await ask();
          if (disposed || mine !== voiceToken) return;
          apply(reply);
          evaluate();
        }
      });
      return first;
    }

    // A seek. While the AI is still working, point it at the new spot. A seek
    // into the middle of a sentence moves back to where it starts. In
    // accurate mode, hold again if the stretch is not translated yet; where
    // there is text to say, hold briefly for the dub's audio instead (see
    // SPEECH_HOLD_AFTER_MS). Skipping the wait once means the user prefers
    // not to be held in this lecture, so a seek never holds after that.
    function onSeeked() {
      if (disposed || !timeline) return;
      const now = video.currentTime || 0;
      if (translating && jobId) api.focus(jobId, now).catch(() => {});
      // Landed in the middle of a sentence the dub can say: start the video
      // at that sentence instead, so it is heard whole in Thai rather than
      // its rest in English. The seek this causes comes back here and
      // carries on below (never moved twice: snappedTo).
      const ours = snappedTo !== null && Math.abs(now - snappedTo) < 0.5;
      snappedTo = null;
      const start = !ours && dub().on && dubber ? dubber.lineStartAt(now) : null;
      if (start !== null) {
        debug(`กรอไป ${Math.round(now)}s กลางประโยค ถอยไปต้นประโยค ${Math.round(start)}s`);
        snappedTo = start;
        video.currentTime = start;
        return;
      }
      if (skipped) return;
      if (phase === "waiting" && catchingUp) {
        catchUp(now); // jumped again while waiting: wait for the new spot instead
        return;
      }
      if (phase !== "playing") return;
      const untranslated =
        translating && !instant() &&
        timeline.finalCoverage(now) < READY_AHEAD_SECONDS && !timeline.translatedToEnd(now);
      if (untranslated) {
        debug(`กรอไป ${Math.round(now)}s ยังไม่แปล รอแปลช่วงนี้ก่อน`);
        phase = "waiting";
        seekHeld = true;
        evaluate();
        return;
      }
      catchUp(now);
    }

    function catchUp(time) {
      const mine = (seekToken += 1);
      // Holding a paused video is pointless; while we hold it ourselves, what
      // counts is whether it was playing before.
      const playing = catchingUp ? hold.wasPlaying : !video.paused;
      // Always start fetching the line due there; wait for it only if playing.
      const due = dub().on && dubber ? dubber.prepareAt(time) : null;
      const ready = playing ? due : null;
      if (!ready) {
        if (catchingUp) {
          catchingUp = false;
          evaluate();
        }
        return;
      }
      let settled = false;
      const settle = () => {
        if (settled || mine !== seekToken || disposed) return;
        settled = true;
        if (catchingUp) {
          catchingUp = false;
          evaluate();
        }
      };
      ready.then(settle);
      sleep(SPEECH_WAIT_MAX_MS).then(settle);
      if (catchingUp) return; // already holding: keep the card up for the new spot
      sleep(SPEECH_HOLD_AFTER_MS).then(() => {
        if (settled || mine !== seekToken || disposed || phase !== "playing" || skipped) return;
        debug(`กรอไป ${Math.round(time)}s รอเสียงพากย์ช่วงนี้`);
        catchingUp = true;
        phase = "waiting";
        evaluate();
      });
    }

    function buildDubber() {
      if (dubber) dubber.dispose();
      voice = makeVoice(dub(), engines);
      dubber = createDubber({
        video,
        timeline,
        voice,
        settings: dub,
        onIssue: (error) => {
          notice = t("พากย์เสียงไม่ได้: {reason}", { reason: String((error && error.message) || error).slice(0, 100) });
          publish();
        },
        debug,
      });
    }

    async function translate(sourceCues) {
      translating = { done: 0, total: 0 };
      const force = await takeForce();
      try {
        const rows = await api.translate(
          { course: site.cacheScope(), lecture: site.cacheId(), title: site.title(), cues: sourceCues, force },
          {
            isCurrent: () => !disposed,
            onJob: (id) => {
              jobId = id;
              // Opened mid-lecture (a resume link, ?start=): translate from here.
              if (!disposed && video.currentTime > 1) api.focus(id, video.currentTime).catch(() => {});
            },
            onPartial: (partial) => {
              if (disposed) return;
              timeline.applyTranslation(partial);
              changed();
            },
            onProgress: (done, total) => {
              if (disposed) return;
              translating = { done, total };
              changed();
            },
          }
        );
        if (disposed) return;
        timeline.applyTranslation(rows);
        translating = null;
        jobId = null;
        changed();
      } catch (error) {
        if (disposed) return;
        translating = null;
        const message = String((error && error.message) || error);
        if (phase === "playing") {
          notice = message;
          publish();
        } else {
          phase = "error";
          releaseVideo();
          emit({ phase, message });
        }
      }
    }

    function onSettings(next, previous) {
      if (!timeline) return;
      const voiceChanged = next.dub.engine !== previous.dub.engine || next.dub.voice !== previous.dub.voice;
      if (voiceChanged || next.dub.on !== previous.dub.on) {
        buildDubber();
        watchVoice().then(changed);
      }
      changed();
    }

    return {
      async start() {
        emit({ phase: "loading" });
        let transcript;
        try {
          transcript = await site.transcript();
        } catch (error) {
          if (!disposed) emit({ phase: "error", message: String((error && error.message) || error) });
          return;
        }
        if (disposed) return;
        if (!transcript.ok) {
          phase = "unavailable";
          emit({ phase, reason: transcript.code });
          return;
        }
        timeline = createTimeline(transcript.cues, { lang: transcript.sourceLang || "EN" });
        try {
          engines = await api.engines();
        } catch {
          engines = [];
        }
        if (disposed) return;
        buildDubber();
        let previous = settings.get();
        unsubscribe = settings.subscribe((next) => {
          const before = previous;
          previous = next;
          onSettings(next, before);
        });
        video.addEventListener("seeked", onSeeked);
        translate(transcript.cues);
        await watchVoice();
        // The translation may already have failed (or finished) meanwhile.
        if (disposed || phase !== "loading") return;
        phase = "waiting";
        evaluate();
      },

      /** The user chose to watch without waiting. */
      skipWait() {
        skipped = true;
        evaluate();
      },

      /** What the subtitle should show at `time` (see core/timeline.js). */
      captionAt(time) {
        return timeline ? timeline.captionAt(time) : null;
      },

      get sourceLang() {
        return timeline ? timeline.lang : "";
      },

      dispose() {
        disposed = true;
        voiceToken += 1;
        unsubscribe();
        video.removeEventListener("seeked", onSeeked);
        if (dubber) dubber.dispose();
        releaseVideo(false);
      },
    };
  }

  UDTH.session = { createSession, READY_AHEAD_SECONDS };
  if (typeof module !== "undefined") module.exports = UDTH.session;
})();
