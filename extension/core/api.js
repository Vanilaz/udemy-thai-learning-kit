// The page's client for the local server.
//
// Every request goes through the service worker as one short `api` message
// (see background.js for why the page cannot call the server itself). This
// module owns what the requests mean: translation jobs and their polling,
// speech, voice warmup, and turning failures into something the user can act
// on. The transport is injected, so it is tested without a browser.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 15 * 60 * 1000;

  /** A failure the user can act on. `kind`: unreachable | extension | server */
  class ApiError extends Error {
    constructor(message, kind) {
      super(message);
      this.kind = kind;
    }
  }

  /** The work belongs to a lecture the user has already left. */
  class Stale extends Error {}

  function describeExtensionError(message) {
    if (/context invalidated|receiving end does not exist/i.test(message)) {
      return "ส่วนขยายเพิ่งถูกอัปเดต กด F5 รีเฟรชหน้านี้หนึ่งครั้ง";
    }
    if (/message (channel|port) closed/i.test(message)) {
      return "การเชื่อมต่อกับส่วนขยายหลุด กำลังลองใหม่";
    }
    return `ติดต่อส่วนขยายไม่ได้: ${message.slice(0, 80)}`;
  }

  /**
   * @param {(message: object) => Promise<object>} send  e.g. chrome.runtime.sendMessage
   * @param {{sleep?: (ms: number) => Promise<void>}} [options]
   */
  function normalizeEngines(list) {
    return (list || []).map((e) => ({
      name: e.name,
      label: e.label,
      ready: Boolean(e.ready),
      error: e.error || "",
      translates: Boolean(e.translates),
      voices: e.voices || [],
    }));
  }

  function createApi(send, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    async function call(method, path, body = null, { timeoutMs = 25000, audio = false } = {}) {
      let reply;
      try {
        reply = await send({ type: "api", method, path, body, timeoutMs, audio });
      } catch (error) {
        throw new ApiError(describeExtensionError(String((error && error.message) || error)), "extension");
      }
      if (!reply) throw new ApiError("ส่วนขยายไม่ตอบ กด F5 รีเฟรชหน้านี้", "extension");
      if (reply.unreachable) {
        throw new ApiError("ยังไม่ได้เปิดเซิร์ฟเวอร์ ดับเบิลคลิก start-server.cmd", "unreachable");
      }
      if (!reply.ok) throw new ApiError(reply.error || `เซิร์ฟเวอร์ตอบ ${reply.status}`, "server");
      return reply.data;
    }

    return {
      /** Server version and its speech engines (what each can do). */
      async health() {
        const health = await call("GET", "/health", null, { timeoutMs: 3000 });
        return { version: health.version || "", engines: normalizeEngines(health.voices) };
      },

      async engines() {
        return (await this.health()).engines;
      },

      /** Start loading an engine's model; repeat to read its state. */
      warmup(engine) {
        return call("POST", "/tts/warmup", { engine }, { timeoutMs: 5000 });
      },

      /**
       * Thai speech for `text`. With `lang` set, `text` is the original and the
       * engine translates it; `spokenText` is then the Thai it said.
       */
      async speak({ voice, text, lang }) {
        const body = { text, voice };
        if (lang) body.source_lang = lang;
        const made = await call("POST", "/tts", body, { timeoutMs: 120000 });
        const audio = await call("GET", made.url, null, { audio: true, timeoutMs: 30000 });
        return { audio, spokenText: made.text || null };
      },

      /** Translate a lecture: resolves with one row per cue ({start,end,en,th}). */
      async translate(payload, { onPartial, onProgress, isCurrent = () => true } = {}) {
        const check = () => {
          if (!isCurrent()) throw new Stale();
        };
        const job = await call("POST", "/translate", payload);
        check();
        if (job.status === "done" && job.cues) return job.cues;

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          check();
          const info = await call("GET", `/job/${job.job}`, null, { timeoutMs: 10000 });
          check();
          if (info.status === "done") return info.cues || [];
          if (info.status === "error") throw new ApiError(`แปลไม่สำเร็จ: ${info.error || "ไม่ทราบสาเหตุ"}`, "server");
          if (info.status === "cancelled") throw new ApiError("งานแปลนี้ถูกยกเลิก", "server");
          // A running job publishes what it has finished so far; handing it
          // over now is what lets the lecture start before the whole is done.
          if (onPartial && info.cues && info.cues.length) onPartial(info.cues);
          if (onProgress) onProgress(info.progress || 0, info.chunks || 0);
        }
        throw new ApiError("แปลนานเกินไป ยกเลิกแล้ว", "server");
      },

      /** Queue a lecture for later (section pre-translation); does not wait. */
      async enqueue(payload) {
        const job = await call("POST", "/translate", { ...payload, batch: true });
        return { cached: Boolean(job.cached), status: job.status };
      },

      queue() {
        return call("GET", "/queue", null, { timeoutMs: 3000 });
      },
    };
  }

  UDTH.api = { createApi, ApiError, Stale };
  if (typeof module !== "undefined") module.exports = UDTH.api;
})();
