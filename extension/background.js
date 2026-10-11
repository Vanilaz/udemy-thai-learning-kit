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

// Extension messages are serialised as JSON, so audio has to travel as text.
// Done in 32KB slices because String.fromCharCode(...bytes) on a whole file
// overflows the argument stack once a clip runs past a second or two.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const slice = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += slice) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + slice));
  }
  return btoa(binary);
}

// Audio synthesis is intentionally a short request like all other local-server
// calls. The page prefetches a few upcoming cues and owns playback itself.
//
// The finished audio is read here and handed back as bytes rather than as a
// URL for the page to load, because a page may not be allowed to reach the
// server at all. Chrome gates requests from a public site to a local address
// behind the Local Network Access permission, and that permission is granted
// per site: it was granted for udemy.com and left unasked on youtube.com, so
// an <audio src="http://127.0.0.1:...">  there never loaded and never failed —
// it just hung, and every dubbed line went silent with no error to show. The
// service worker holds a host permission for the server and is not subject to
// that gate, so the bytes come through here and reach the page as a blob it
// already owns. Windows Natural kept working throughout because it speaks in
// the browser and never touches the server, which is what made this look like
// a text-to-speech bug rather than a network one.
async function synthesizeSpeech(payload) {
  const base = await serverUrl();
  const response = await fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `เซิร์ฟเวอร์ตอบ ${response.status}`);

  const audio = await fetch(`${base}${data.url}`);
  if (!audio.ok) throw new Error(`อ่านไฟล์เสียงไม่ได้ (HTTP ${audio.status})`);
  return {
    ...data,
    type: audio.headers.get("Content-Type") || "audio/mpeg",
    base64: toBase64(await audio.arrayBuffer()),
  };
}

// Ask the server to load a local voice model now, and report how far it got.
// Safe to repeat: while loading, or once loaded, it only answers the state.
async function warmupVoice(engine) {
  const base = await serverUrl();
  const response = await localFetch(`${base}/tts/warmup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine }),
  }, 5000);
  // An older server has no such route — treat that as "nothing to wait for".
  if (response.status === 404) return { state: "none", error: "" };
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `เซิร์ฟเวอร์ตอบ ${response.status}`);
  return data;
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

  if (message.type === "warmupVoice") {
    warmupVoice(message.engine)
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
