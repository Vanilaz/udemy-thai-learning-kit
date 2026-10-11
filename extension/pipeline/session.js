// One lecture, from its captions to a playing, subtitled, dubbed video.
//
// The session is a small state machine and the only place that decides
// whether the video may play:
//
//   loading -> unavailable {reason} | error {message}
//           -> waiting {waitingFor: {translation?, voice?}} -> playing {translating, notice?}
//
// It holds the video while anything in `waitingFor` is outstanding, and lets
// it go the moment nothing is (or the user skips). The views render whatever
// state it publishes; they never decide on their own.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});
  const { createTimeline } = UDTH.timeline || require("../core/timeline.js");
  const { createDubber } = UDTH.dubber || require("./dubber.js");

  // How much translated runway is enough to hand the player back. Chunks land
  // out of order, so what matters is whether the stretch the viewer is about
  // to watch is covered, not how many chunks are done.
  const READY_AHEAD_SECONDS = 90;

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
        };
      }
      if (dub().on && voiceLoading) reasons.voice = { engine: dub().engine };
      if (skipped || !Object.keys(reasons).length) {
        phase = "playing";
        waitingFor = {};
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
        if (reply.state === "error") notice = `โหลดเสียง ${d.engine} ไม่สำเร็จ: ${reply.error || ""}`.trim();
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

    function buildDubber() {
      if (dubber) dubber.dispose();
      voice = makeVoice(dub(), engines);
      dubber = createDubber({
        video,
        timeline,
        voice,
        settings: dub,
        onIssue: (error) => {
          notice = `พากย์เสียงไม่ได้: ${String((error && error.message) || error).slice(0, 100)}`;
          publish();
        },
        log,
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
        if (dubber) dubber.dispose();
        releaseVideo(false);
      },
    };
  }

  UDTH.session = { createSession, READY_AHEAD_SECONDS };
  if (typeof module !== "undefined") module.exports = UDTH.session;
})();
