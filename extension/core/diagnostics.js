"use strict";
(() => {
  function redact(value) {
    return String(value || "")
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, u => u.split(/[?#]/)[0])
      .replace(/(:\/\/)[^/@\s]+@/g, "$1[REDACTED]@")
      .replace(/(?:authorization\s*[:=]\s*)?bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/sk-[\w-]+|AIza[\w-]+/g, "[REDACTED]")
      .replace(/((?:api[_-]?key|password|token|secret|key|credential)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1[REDACTED]")
      .slice(0, 1000);
  }
  function createDiagnostics({storage, post, now = Date.now}) {
    const key = "udthErrorOutbox";
    let chain = Promise.resolve();
    let retryAt = 0;
    const serial = fn => (chain = chain.catch(() => {}).then(fn));
    return {
      record(event = {}) {
        return serial(async () => {
          const stored = await storage.get(key);
          const queue = Array.isArray(stored[key]) ? stored[key] : [];
          queue.push({time: new Date(now()).toISOString(), source: redact(event.source).slice(0, 50),
            message: redact(event.message), path: redact(event.path).split("?")[0].slice(0, 160),
            status: Number.isInteger(event.status) ? event.status : 0});
          await storage.set({[key]: queue.slice(-100)});
        });
      },
      flush() {
        return serial(async () => {
          if (now() < retryAt) return;
          const stored = await storage.get(key);
          const queue = Array.isArray(stored[key]) ? stored[key] : [];
          if (!queue.length) return;
          try {
            if (!await post(queue)) throw new Error("Diagnostics unavailable");
            await storage.set({[key]: []});
          } catch {
            retryAt = now() + 10000;
          }
        });
      },
    };
  }
  globalThis.UDTH = globalThis.UDTH || {};
  globalThis.UDTH.diagnostics = {createDiagnostics, redact};
  if (typeof module !== "undefined") module.exports = globalThis.UDTH.diagnostics;
})();
