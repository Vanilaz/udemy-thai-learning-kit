// Voices: how a sentence becomes sound. Both satisfy the interface the dubber
// expects (see pipeline/dubber.js): canTranslate, prepare(words), speak(words, opts).
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const MAX_CLIPS = 40; // decoded clips kept; older blob URLs are revoked
  const THAI_CHARS_PER_SECOND = 12; // browser voices give no duration up front

  function blobUrl({ base64, type }) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: type || "audio/mpeg" }));
  }

  /** Audio from the local server, any engine (Edge, Google, Seamless, OmniVoice). */
  function createServerVoice({ api, voiceId, translates, createAudio = () => new Audio(), toUrl = blobUrl, revoke = (u) => URL.revokeObjectURL(u) }) {
    const clips = new Map(); // words key -> Promise<{url, element, spokenText}>

    function evictOldest() {
      while (clips.size > MAX_CLIPS) {
        const [oldestKey, oldest] = clips.entries().next().value;
        clips.delete(oldestKey);
        oldest.then((clip) => revoke(clip.url), () => {});
      }
    }

    function prepare(words) {
      const key = `${words.lang || "th"}|${words.text}`;
      if (clips.has(key)) {
        // Refresh its place: recently used clips are kept longest.
        const hit = clips.get(key);
        clips.delete(key);
        clips.set(key, hit);
        return hit;
      }
      const clip = api.speak({ voice: voiceId, text: words.text, lang: words.lang }).then(({ audio, spokenText }) => {
        const url = toUrl(audio);
        // Decoding now means playback starts on the tick it is asked for.
        const element = createAudio();
        element.preload = "auto";
        element.src = url;
        element.load();
        return { url, element, spokenText };
      });
      clip.catch(() => clips.delete(key));
      clips.set(key, clip);
      evictOldest();
      return clip;
    }

    function speak(words, { volume, fitRate }) {
      let element = null;
      let finish;
      const done = new Promise((resolve, reject) => {
        finish = resolve;
        prepare(words).then((clip) => {
          element = clip.element;
          element.currentTime = 0;
          element.volume = volume;
          // Without this Chrome shifts pitch along with rate and the voice squeaks.
          element.preservesPitch = true;
          const applyRate = () => {
            if (element.duration > 0) element.playbackRate = fitRate(element.duration);
          };
          if (element.readyState >= 1) applyRate();
          else element.addEventListener("loadedmetadata", applyRate, { once: true });
          element.onended = () => resolve();
          element.onerror = () => reject(new Error("เล่นไฟล์เสียงไม่ได้"));
          return element.play();
        }).catch(reject);
      });
      return {
        done,
        stop() {
          if (element) element.pause();
          finish();
        },
      };
    }

    return { canTranslate: Boolean(translates), prepare, speak };
  }

  /** Windows / Chrome built-in voices, spoken in the page. Cannot translate. */
  function createBrowserVoice({ synth = globalThis.speechSynthesis, voiceName = "" } = {}) {
    function pickVoice() {
      const voices = synth.getVoices();
      const thai = (v) => /^th(?:-|_)/i.test(v.lang);
      return (
        voices.find((v) => v.name === voiceName) ||
        // Windows exposes its cloud-backed voices as "Online (Natural)".
        voices.find((v) => thai(v) && /natural|online/i.test(v.name)) ||
        voices.find(thai) ||
        null
      );
    }

    return {
      canTranslate: false,
      prepare: async () => ({}),
      speak(words, { volume, fitRate }) {
        const utterance = new SpeechSynthesisUtterance(words.text);
        utterance.voice = pickVoice();
        utterance.lang = "th-TH";
        utterance.volume = volume;
        utterance.rate = fitRate(words.text.length / THAI_CHARS_PER_SECOND);
        const done = new Promise((resolve) => {
          utterance.onend = () => resolve();
          utterance.onerror = () => resolve();
        });
        synth.speak(utterance);
        return { done, stop: () => synth.cancel() };
      },
    };
  }

  /** The Thai voices this browser has, for the voice picker. */
  function browserVoiceNames(synth = globalThis.speechSynthesis) {
    return synth.getVoices().filter((v) => /^th(?:-|_)/i.test(v.lang)).map((v) => v.name);
  }

  /**
   * The voice id to synthesize with. "" means the engine's first voice. A
   * saved id from another engine is ignored: the server routes requests by
   * voice id, so it would quietly speak through that other engine (this sent
   * every "automatic" Seamless line to Edge).
   */
  function resolveVoiceId(dub, engine, fallback = "th-TH-NiwatNeural") {
    const voices = (engine && engine.voices) || [];
    if (voices.some((v) => v.id === dub.voice)) return dub.voice;
    return (voices[0] && voices[0].id) || fallback;
  }

  UDTH.voices = { createServerVoice, createBrowserVoice, browserVoiceNames, resolveVoiceId };
  if (typeof module !== "undefined") module.exports = UDTH.voices;
})();
