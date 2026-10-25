// Service worker: the only part of the extension that talks to the local
// translation server.
//
// Every handler here must finish fast. An MV3 service worker is not a
// long-lived background page: Chrome terminates it when idle and caps how long
// it may stay alive, so waiting out a 30-90s translation in here got the worker
// killed mid-wait ("message channel closed before a response was received").
// So this file only ever forwards one short request per message. The page
// (core/api.js) owns what requests mean and all the waiting, because it lives
// in the tab and is not subject to that lifetime.

/* global importScripts */
importScripts("core/i18n.js");
const { t } = UDTH.i18n;

// Errors written here reach the page as text, so they follow the language the
// user chose. The worker can restart at any time: read it again on start.
// Same rule as core/settings.js: saved settings without a language predate the
// choice and stay Thai; no settings at all is a new install and follows the browser.
const followLanguage = (settings) => UDTH.i18n.setLang(settings ? settings.lang || "th" : "auto");
chrome.storage.local.get("settings").then((stored) => followLanguage(stored.settings), () => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) followLanguage(changes.settings.newValue);
});

const DEFAULT_SERVER = "http://127.0.0.1:8765";

async function localFetch(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(t("เซิร์ฟเวอร์ไม่ตอบภายใน {seconds} วินาที", { seconds: timeoutMs / 1000 }));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function serverUrl() {
  const stored = await chrome.storage.local.get("serverUrl");
  return stored.serverUrl || DEFAULT_SERVER;
}

// Extension messages are serialised as JSON, so audio travels as text. Done
// in 32KB slices: String.fromCharCode(...bytes) on a whole file overflows the
// argument stack once a clip runs past a second or two.
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const slice = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += slice) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + slice));
  }
  return btoa(binary);
}

// Forward one request to the server: {ok, status, data} or {ok:false, error}
// ({unreachable:true} when nothing answered at all).
//
// `audio: true` returns the body as bytes rather than a URL for the page to
// load, because a page may not be allowed to reach the server at all: Chrome
// gates requests from a public site to a local address behind the Local
// Network Access permission, granted per site. It was granted for udemy.com
// and never asked on youtube.com, so an <audio src="http://127.0.0.1:..."> there
// neither loaded nor failed, and every dubbed line went silent with no error.
// This worker holds a host permission for the server and is not subject to
// that gate, so the bytes come through here and reach the page as a blob it owns.
async function apiRequest({ method = "GET", path, body = null, timeoutMs = 25000, audio = false }) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return { ok: false, status: 0, error: "invalid path" };
  }
  const base = await serverUrl();
  let response;
  try {
    response = await localFetch(
      `${base}${path}`,
      {
        method,
        cache: "no-store",
        headers: body === null ? undefined : { "Content-Type": "application/json" },
        body: body === null ? undefined : JSON.stringify(body),
      },
      timeoutMs
    );
  } catch (error) {
    return { ok: false, unreachable: true, error: String((error && error.message) || error) };
  }
  if (audio) {
    if (!response.ok) return { ok: false, status: response.status, error: t("อ่านไฟล์เสียงไม่ได้ (HTTP {status})", { status: response.status }) };
    return {
      ok: true,
      status: response.status,
      data: { type: response.headers.get("Content-Type") || "audio/mpeg", base64: toBase64(await response.arrayBuffer()) },
    };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, status: response.status, error: data.error || t("เซิร์ฟเวอร์ตอบ {status}", { status: response.status }) };
  return { ok: true, status: response.status, data };
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
      const defaultAudioIdx =
        list && typeof list.defaultAudioTrackIndex === "number" ? list.defaultAudioTrackIndex : -1;
      const defaultAudio = list && list.audioTracks && list.audioTracks[defaultAudioIdx];
      const defaultCaptionIdx =
        defaultAudio && typeof defaultAudio.defaultCaptionTrackIndex === "number"
          ? defaultAudio.defaultCaptionTrackIndex
          : -1;

      // Only plain serialisable fields cross the world boundary.
      return {
        tracks: tracks.map((t, idx) => ({
          languageCode: t.languageCode || "",
          kind: t.kind || "",
          baseUrl: t.baseUrl || "",
          isDefault: idx === defaultCaptionIdx || Boolean(t.isDefault),
        })),
      };
    },
  });

  const value = (result && result.result) || {};
  if (value.error) throw new Error(value.error);
  return value.tracks || [];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "api") {
    apiRequest(message).then(sendResponse, (error) =>
      sendResponse({ ok: false, status: 0, error: String((error && error.message) || error) })
    );
    return true;
  }

  if (message.type === "youtubeCaptions") {
    const tabId = sender.tab && sender.tab.id;
    if (!tabId) {
      sendResponse({ ok: false, error: t("ไม่รู้ว่าอยู่แท็บไหน") });
      return false;
    }
    youtubeCaptionTracks(tabId)
      .then((tracks) => sendResponse({ ok: true, tracks }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  return false;
});
