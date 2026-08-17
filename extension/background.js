// Service worker: the only place that talks to the local translation server.
//
// Every handler here must finish fast. An MV3 service worker is not a
// long-lived background page — Chrome terminates it when idle and caps how
// long it may stay alive, so waiting out a 30-90s translation in here gets the
// worker killed mid-wait and the caller's sendMessage rejects with
// "message channel closed before a response was received".
//
// So this file only ever does one short round trip per message: start a job,
// or report a job's status. The content script owns the waiting, because it
// lives in the page and is not subject to that lifetime.

const DEFAULT_SERVER = "http://127.0.0.1:8765";

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
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// Kick off a translation. Returns immediately with the job id — or with the
// finished cues when the server already had them cached.
async function startJob(payload) {
  const base = await serverUrl();
  const response = await fetch(`${base}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`เซิร์ฟเวอร์ตอบ ${response.status} ${detail.slice(0, 200)}`);
  }
  return response.json();
}

async function jobStatus(jobId) {
  const base = await serverUrl();
  const response = await fetch(`${base}/job/${jobId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`อ่านสถานะงานไม่ได้ (HTTP ${response.status})`);
  return response.json();
}

// How much of a queued section is left, for the on-page badge and the popup.
async function queueStatus() {
  const base = await serverUrl();
  const response = await fetch(`${base}/queue`, { cache: "no-store" });
  if (!response.ok) throw new Error(`อ่านคิวไม่ได้ (HTTP ${response.status})`);
  return response.json();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "health") {
    checkHealth().then(sendResponse);
    return true;
  }

  if (message.type === "startJob") {
    startJob(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === "jobStatus") {
    jobStatus(message.jobId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === "queueStatus") {
    queueStatus()
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return false;
});
