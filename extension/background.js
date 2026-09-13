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

async function localFetch(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`เซิร์ฟเวอร์ไม่ตอบภายใน ${timeoutMs / 1000} วินาที ลองใหม่ได้จากคิว`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


async function serverUrl() {
  const stored = await chrome.storage.local.get("serverUrl");
  return stored.serverUrl || DEFAULT_SERVER;
}

async function checkHealth() {
  const base = await serverUrl();
  try {
    const response = await localFetch(`${base}/health`, { cache: "no-store" }, 3000);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const data = await response.json();
    // `voices` is the engine catalogue — which speech engines the server has,
    // which are usable, and what each offers. The UI is built from it rather
    // than from a hardcoded list, so adding an engine server-side is enough.
    return { ok: true, engine: data.engine, voices: data.voices || [] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// Kick off a translation. Returns immediately with the job id — or with the
// finished cues when the server already had them cached.
async function startJob(payload) {
  const base = await serverUrl();
  const response = await localFetch(`${base}/translate`, {
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
  const response = await localFetch(`${base}/job/${jobId}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`อ่านสถานะงานไม่ได้ (HTTP ${response.status})`);
  return response.json();
}

// How much of a queued section is left, for the on-page badge and the popup.
async function queueStatus() {
  const base = await serverUrl();
  const response = await localFetch(`${base}/queue`, { cache: "no-store" }, 3000);
  if (!response.ok) throw new Error(`อ่านคิวไม่ได้ (HTTP ${response.status})`);
  return response.json();
}

// Cancel a queued or running job, or requeue one that failed. The ids come
// from the server's own queue listing, but they are still checked here: they
// are pasted straight into a URL, and an unchecked one would let a crafted
// message reach any path on the local server.
async function jobAction(jobId, action) {
  if (!/^[a-f0-9]{20}$/.test(String(jobId || "")) || !["cancel", "retry"].includes(action)) {
    throw new Error("คำสั่งจัดการคิวไม่ถูกต้อง");
  }
  const base = await serverUrl();
  const response = await localFetch(`${base}/job/${jobId}/${action}`, {
    method: "POST",
    // The server requires a JSON body with a real Content-Length, so an empty
    // object is sent rather than no body at all.
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `เซิร์ฟเวอร์ตอบ ${response.status}`);
  return data;
}

// Audio synthesis is intentionally a short request like all other local-server
// calls. The page prefetches a few upcoming cues and owns playback itself.
async function synthesizeSpeech(payload) {
  const base = await serverUrl();
  const response = await localFetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `เซิร์ฟเวอร์ตอบ ${response.status}`);
  return { ...data, url: `${base}${data.url}` };
}

// Read the caption list straight out of YouTube's live player object.
//
// A content script runs in an isolated world and cannot see the page's own
// variables, and re-fetching the watch page HTML is unreliable — YouTube does
// not always inline the caption list for a plain fetch, and after a
// client-side navigation the original HTML is long gone anyway.
//
// `getPlayerResponse()` is the player's public method and always describes the
// video actually loaded, so it survives navigation with no extra work.
async function youtubeCaptionTracks(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const player = document.querySelector("#movie_player");
      const response =
        (player && player.getPlayerResponse && player.getPlayerResponse()) ||
        window.ytInitialPlayerResponse ||
        null;
      if (!response) return { error: "no-player" };

      const list = response.captions && response.captions.playerCaptionsTracklistRenderer;
      const tracks = (list && list.captionTracks) || [];
      // Only plain serialisable fields cross the world boundary.
      return {
        tracks: tracks.map((t) => ({
          languageCode: t.languageCode || "",
          kind: t.kind || "",
          baseUrl: t.baseUrl || "",
        })),
      };
    },
  });

  const value = (result && result.result) || {};
  if (value.error) throw new Error(value.error);
  return value.tracks || [];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "youtubeCaptions") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "ไม่รู้ว่าอยู่แท็บไหน" });
      return false;
    }
    youtubeCaptionTracks(tabId)
      .then((tracks) => sendResponse({ ok: true, tracks }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

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

  if (message.type === "jobAction") {
    jobAction(message.jobId, message.action)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === "synthesizeSpeech") {
    synthesizeSpeech(message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return false;
});
