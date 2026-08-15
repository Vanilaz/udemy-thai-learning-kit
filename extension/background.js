// Service worker: the only place that talks to the local translation server.
//
// Content scripts can't reliably do cross-origin fetches under MV3, so the
// content script sends a message here and this worker does the HTTP work and
// polls the job until it finishes.

const DEFAULT_SERVER = "http://127.0.0.1:8765";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

async function serverUrl() {
  const stored = await chrome.storage.local.get("serverUrl");
  return stored.serverUrl || DEFAULT_SERVER;
}

async function checkHealth() {
  const base = await serverUrl();
  try {
    const response = await fetch(`${base}/health`, { cache: "no-store" });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    return { ok: true, engine: data.engine };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Translate a lesson, reporting progress back to the requesting tab.
async function translate(payload, tabId) {
  const base = await serverUrl();

  const started = await fetch(`${base}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!started.ok) {
    const detail = await started.text().catch(() => "");
    throw new Error(`เซิร์ฟเวอร์ตอบ ${started.status} ${detail.slice(0, 200)}`);
  }

  const job = await started.json();
  if (job.status === "done" && job.cues) {
    return job.cues;
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const response = await fetch(`${base}/job/${job.job}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`อ่านสถานะงานไม่ได้ (HTTP ${response.status})`);
    const state = await response.json();

    if (state.status === "done") return state.cues;
    if (state.status === "error") throw new Error(state.error || "แปลไม่สำเร็จ");

    if (tabId !== undefined) {
      chrome.tabs
        .sendMessage(tabId, {
          type: "progress",
          progress: state.progress || 0,
          chunks: state.chunks || 0,
        })
        .catch(() => {});
    }
  }
  throw new Error("แปลนานเกินไป ยกเลิกแล้ว");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "health") {
    checkHealth().then(sendResponse);
    return true;
  }

  if (message.type === "translate") {
    translate(message.payload, sender.tab && sender.tab.id)
      .then((cues) => sendResponse({ ok: true, cues }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return false;
});
