// Site adapters. Loaded first; every other content script shares this world.
//
// Everything that differs between the sites we support lives behind one small
// interface, so the rest (main.js, the session, the UI) never has to know
// which site it is running on:
//
//   name              "udemy" | "youtube"
//   pageKey()         identity of the page on screen, or null if not translatable
//   cacheScope()      the "course" half of the server's cache key
//   cacheId()         the "lecture" half of it — must be stable across visits
//   title()           human-readable name of what is playing
//   playerContainer() element to anchor the overlay to (null -> video's parent)
//   describe()        what kind of page this is, plus whatever videoCues needs
//   videoCues(p)      the original-language cues and their language, or a
//                     reason there are none ({ok:false, code})
//   supportsSection   whether "translate the whole section" applies here
//
// The Udemy adapter is sites/udemy.js. This file holds the shared helpers and
// the YouTube adapter.

var UDTH = window.UDTH || (window.UDTH = {});

// Find the row of buttons in a player's control bar, without knowing anything
// about that player's class names.
//
// Matching on classes is what failed on Udemy: they are hashed per build and
// rearranged between releases. An anchor that must exist — the fullscreen
// button — is far more stable, and whatever contains it is by definition the
// place player controls live.
UDTH.findControlBar = function findControlBar(video) {
  // Walk up from the video to the player root, then search inside it, so a
  // second player elsewhere on the page cannot be picked up by mistake.
  let root = video;
  for (let i = 0; i < 6 && root && root.parentElement; i += 1) root = root.parentElement;
  root = root || document.body;

  const anchors = [
    '[data-purpose*="fullscreen"]',
    '[data-purpose*="settings"]',
    '[data-purpose*="captions"]',
    '[data-purpose*="volume"]',
    'button[aria-label*="ull screen" i]',
    'button[aria-label*="ullscreen" i]',
    'button[title*="ull screen" i]',
    'button[aria-label*="เต็มหน้าจอ"]',
    ".ytp-fullscreen-button",
  ];

  // Anything that contains the video itself is a player wrapper, not a row of
  // buttons. Mounting into one of those is what stretched the button into a
  // stripe across the player, so such candidates are rejected outright.
  const usable = (el) =>
    el &&
    el !== document.body &&
    el !== document.documentElement &&
    !el.contains(video);

  for (const selector of anchors) {
    const control = root.querySelector(selector);
    if (!control) continue;

    const bar = control.parentElement;
    if (!usable(bar)) continue;

    // A parent holding only the anchor is a wrapper around a single button;
    // step up once so our button lands beside its peers rather than inside
    // someone else's box — but only if that step is still a control row.
    if (bar.children.length < 2 && usable(bar.parentElement)) return bar.parentElement;
    return bar;
  }
  return null;
};

UDTH.util = {
  async getJson(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(UDTH.i18n.t("เซิร์ฟเวอร์ตอบ {status}", { status: response.status }));
    return response.json();
  },

  // Pull one JSON object out of a page's inline script by brace matching.
  //
  // A regex cannot do this: the payload we want is megabytes of nested objects
  // containing braces inside strings, and `{.*?}` stops at the first one.
  // Scanning with a string/escape state machine is the only reliable way.
  extractJson(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const open = html.indexOf("{", at);
    if (open < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < html.length; i += 1) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(open, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  },
};

// ------------------------------------------------------------------ YouTube

// YouTube serves captions as its own "json3" format rather than WebVTT:
//   { events: [ { tStartMs, dDurationMs, segs: [{ utf8 }] } ] }
// Auto-generated tracks split every word into its own seg, so a line is the
// concatenation of an event's segs, not one seg.
function parseJson3(data) {
  const cues = [];
  for (const event of (data && data.events) || []) {
    if (!event.segs) continue;
    const text = event.segs
      .map((seg) => seg.utf8 || "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === "\n") continue;

    const start = (event.tStartMs || 0) / 1000;
    const end = start + (event.dDurationMs || 0) / 1000;
    // ASR tracks emit zero-length events to roll the caption over; they carry
    // no new speech and would become empty dub segments.
    if (end <= start) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

// Group the word-level fragments an auto-generated track produces into usable
// lines. Left alone they translate badly — two words is not enough context for
// a translator to work from, and Udemy-style subtitle cues they are not.
//
// Auto-captions carry no punctuation at all, so there are no sentence
// boundaries to find: the only signals available are elapsed time and the gaps
// where the speaker stopped.
function groupCues(cues, targetSeconds = 5, gapSeconds = 0.8) {
  const grouped = [];
  for (const cue of cues) {
    const last = grouped[grouped.length - 1];
    const roomLeft = last && cue.end - last.start <= targetSeconds;
    const continuous = last && cue.start - last.end <= gapSeconds;
    // A full stop does appear on tracks that were written by hand; honour it.
    const closed = last && /[.!?]["')\]]?\s*$/.test(last.text);

    if (last && roomLeft && continuous && !closed) {
      last.text += " " + cue.text;
      last.end = cue.end;
    } else {
      grouped.push({ ...cue });
    }
  }
  return grouped;
}

// ---- Proof of Origin Token -------------------------------------------------
//
// YouTube answers a caption request without a `pot` value with 200 and an
// empty body. pot-interceptor.js watches the player's own traffic in the page
// world and announces any token it sees via DOM dataset and events.

const pot = {
  get token() {
    return (document.documentElement && document.documentElement.dataset && document.documentElement.dataset.udthPot) || this._token || null;
  },
  set token(val) {
    this._token = val;
    if (val && document.documentElement && document.documentElement.dataset) {
      document.documentElement.dataset.udthPot = val;
    }
  },
  _token: null,
};

window.addEventListener("udth:pot", (event) => {
  pot.token = event.detail;
});

const POT_WAIT_MS = 3000;
const POT_POLL_MS = 100;
const POT_ATTEMPTS = 3;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPot(ms) {
  const deadline = Date.now() + ms;
  while (!pot.token && Date.now() < deadline) await wait(POT_POLL_MS);
  return pot.token;
}

// Nothing makes the player mint a token except making it ask for captions, and
// the only handle on that is its own CC button.
async function ensurePotToken() {
  if (pot.token) return pot.token;

  const button = document.querySelector(".ytp-subtitles-button");
  if (!button) {
    console.log("[udth] ไม่พบปุ่ม CC ของ YouTube — ขอ token ไม่ได้");
    return null;
  }

  for (let attempt = 1; attempt <= POT_ATTEMPTS && !pot.token; attempt += 1) {
    const wasPressed = button.getAttribute("aria-pressed") === "true";
    button.click();
    await waitForPot(1200);
    if (!wasPressed && button.getAttribute("aria-pressed") === "true") {
      // Restore state if CC was originally off so native subtitles do not linger
      button.click();
    }
    if (pot.token) break;
    await waitForPot(POT_WAIT_MS);
    if (!pot.token) log(`ยังไม่ได้ token PoT (ครั้งที่ ${attempt}/${POT_ATTEMPTS})`);
  }
  return pot.token;
}

function log(...args) {
  console.log("[udth]", ...args);
}

function youtubeVideoId() {
  if (location.pathname.startsWith("/watch")) {
    return new URLSearchParams(location.search).get("v");
  }
  const short = location.pathname.match(/^\/shorts\/([\w-]+)/);
  return short ? short[1] : null;
}

// Preferred: ask the live player object, via the service worker, which can run
// code in the page's own world. It always describes the video actually loaded.
async function tracksFromPlayer() {
  const res = await chrome.runtime.sendMessage({ type: "youtubeCaptions" });
  if (!res || !res.ok) throw new Error((res && res.error) || UDTH.i18n.t("อ่านรายการคำบรรยายไม่ได้"));
  return res.tracks || [];
}

// Fallback: re-fetch the watch page and read `ytInitialPlayerResponse` out of
// it. Less reliable — YouTube does not always inline the caption list for a
// plain fetch — but it costs nothing to try when the player route fails.
async function tracksFromHtml(videoId) {
  const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(UDTH.i18n.t("YouTube ตอบ {status}", { status: response.status }));
  const html = await response.text();

  const player = UDTH.util.extractJson(html, "ytInitialPlayerResponse");
  const list =
    player && player.captions && player.captions.playerCaptionsTracklistRenderer;
  const tracks = (list && list.captionTracks) || [];
  const defaultAudioIdx =
    list && typeof list.defaultAudioTrackIndex === "number" ? list.defaultAudioTrackIndex : -1;
  const defaultAudio = list && list.audioTracks && list.audioTracks[defaultAudioIdx];
  const defaultCaptionIdx =
    defaultAudio && typeof defaultAudio.defaultCaptionTrackIndex === "number"
      ? defaultAudio.defaultCaptionTrackIndex
      : -1;

  return tracks.map((t, idx) => ({
    languageCode: t.languageCode || "",
    kind: t.kind || "",
    baseUrl: t.baseUrl || "",
    isDefault: idx === defaultCaptionIdx || Boolean(t.isDefault),
  }));
}

async function fetchCaptionTracks(videoId) {
  try {
    const tracks = await tracksFromPlayer();
    if (tracks.length) return tracks;
    console.log("[udth] ตัวเล่น YouTube ไม่มีรายการคำบรรยาย — ลองอ่านจาก HTML แทน");
  } catch (err) {
    console.log("[udth] อ่านจากตัวเล่นไม่ได้:", err && err.message, "— ลองอ่านจาก HTML แทน");
  }
  return tracksFromHtml(videoId);
}

// `c=WEB` identifies the caller as the web player; without it the token is
// rejected even when it is valid.
function captionUrl(track, token, { json = false, asr = true } = {}) {
  let url = `${track.baseUrl}&c=WEB`;
  if (json) url += "&fmt=json3";
  if (token) url += `&pot=${encodeURIComponent(token)}`;
  // Some auto-generated tracks only answer when `kind=asr` is absent.
  return asr ? url : url.replace("&kind=asr", "");
}

// YouTube double-escapes caption text ("&amp;#39;"), so entities are decoded
// through the DOM rather than by hand.
const decoder = typeof document !== "undefined" && document.createElement ? document.createElement("textarea") : null;
function unescapeHtml(value) {
  if (!decoder) return value;
  decoder.innerHTML = value;
  return decoder.value;
}

// <transcript><text start="12.5" dur="3.2">…</text></transcript>
function parseTimedTextXml(text) {
  if (typeof DOMParser === "undefined") return [];
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const cues = [];
  for (const node of doc.getElementsByTagName("text")) {
    const body = unescapeHtml((node.textContent || "").trim())
      .replace(/\s+/g, " ")
      .trim();
    const start = parseFloat(node.getAttribute("start") || "0");
    const dur = parseFloat(node.getAttribute("dur") || "0");
    if (!body || !(dur > 0)) continue;
    cues.push({ start, end: start + dur, text: body });
  }
  return cues;
}

async function readTimedText(url, asJson) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return { status: response.status, cues: null };
  const body = await response.text();
  // An empty 200 is YouTube declining to serve the track. Parsing would report
  // it as a syntax error and hide what actually happened.
  if (!body.trim()) return { status: 200, cues: null };
  try {
    const cues = asJson ? parseJson3(JSON.parse(body)) : parseTimedTextXml(body);
    return { status: 200, cues: cues.length ? cues : null };
  } catch {
    return { status: 200, cues: null };
  }
}

async function fetchTimedText(track) {
  const token = await ensurePotToken();
  if (!token) log("ไม่ได้ token PoT — ลองดึงซับแบบไม่มี token");

  // Ordered by what YouTube web player natively answers: json3 with asr marker.
  const attempts = [
    { json: true, asr: true },
    { json: true, asr: false },
    { json: false, asr: true },
    { json: false, asr: false },
  ];

  for (const options of attempts) {
    let result;
    try {
      result = await readTimedText(captionUrl(track, token, options), options.json);
    } catch (err) {
      log("อ่าน timedtext ไม่ได้:", err && err.message);
      return { ok: false, code: "caption-fetch-failed" };
    }
    if (result.cues) return { ok: true, cues: result.cues };
    log(
      `timedtext ตอบ ${result.status} แต่ไม่ได้เนื้อหา ` +
        `(${options.json ? "json3" : "xml"}, kind=asr ${options.asr ? "คงไว้" : "ตัดออก"})`
    );
  }
  return { ok: false, code: token ? "caption-blocked" : "caption-no-token" };
}

function pickTrack(tracks, prefix) {
  const matches = tracks.filter((t) => new RegExp(`^${prefix}`, "i").test(t.languageCode || ""));
  if (!matches.length) return null;
  // A track someone wrote beats one a machine transcribed.
  return matches.find((t) => t.kind !== "asr") || matches[0];
}

// Which track to translate *from*, without assuming the video is in English.
//
// Courses are not all English — the same player carries Hindi, Spanish and
// Portuguese lessons — and demanding English meant refusing to translate any
// of them.
function pickSourceTrack(tracks) {
  const usable = tracks.filter((t) => t.baseUrl && !/^th/i.test(t.languageCode || ""));
  if (!usable.length) return null;

  // 1. If YouTube marked a track as default (from defaultCaptionTrackIndex/defaultAudio), use it.
  const def = usable.find((t) => t.isDefault);
  if (def) return def;

  const inLang = (t, lang) => (t.languageCode || "").toLowerCase().split("-")[0] === lang;
  const written = usable.filter((t) => t.kind !== "asr");
  const asrTracks = usable.filter((t) => t.kind === "asr");

  // Determine spoken language from ASR:
  // If there is only one ASR track, YouTube transcribed that specific spoken audio.
  // When YouTube provides multilingual ASR tracks (e.g. 14 languages sorted alphabetically),
  // prefer English as the base transcription unless a human track or default indicates otherwise.
  let asr = null;
  if (asrTracks.length === 1) {
    asr = asrTracks[0];
  } else if (asrTracks.length > 1) {
    asr = asrTracks.find((t) => inLang(t, "en")) || asrTracks[0];
  }

  const spoken = asr ? (asr.languageCode || "").split("-")[0].toLowerCase() : "";

  return (
    // A human-written track in the spoken language is the best source there is.
    (spoken && written.find((t) => inLang(t, spoken))) ||
    // Otherwise English written by a human, the translator's strongest pair.
    written.find((t) => inLang(t, "en")) ||
    written[0] ||
    asr ||
    usable[0]
  );
}

UDTH.youtube = {
  name: "youtube",
  // Exposed for tests/sites.test.cjs; not part of the site interface.
  __pickSourceTrack: pickSourceTrack,
  supportsSection: false,

  pageKey: youtubeVideoId,
  cacheScope: () => "youtube",
  cacheId: youtubeVideoId,

  title() {
    const heading = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string"
    );
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    return text || document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim() || "วิดีโอ";
  },

  // Anchoring to the player element keeps the overlay inside the fullscreen
  // subtree, and keeps it out of the way of the description below.
  playerContainer() {
    return document.querySelector("#movie_player") || null;
  },

  captionsButton() {
    return document.querySelector(".ytp-subtitles-button");
  },

  // The cluster holding the settings gear and the fullscreen button. Our
  // button goes in front of them so it never displaces the fullscreen control
  // people reach for by position.
  controlBar() {
    return (
      document.querySelector(".ytp-right-controls") ||
      UDTH.findControlBar(document.querySelector("video"))
    );
  },

  async describe() {
    const id = youtubeVideoId();
    if (!id) return null;
    return { kind: "video", payload: { id } };
  },

  async videoCues(payload) {
    const tracks = await fetchCaptionTracks(payload.id);
    if (!tracks.length) return { ok: false, code: "no-captions" };

    // Only a human-made Thai track beats what we produce; YouTube's auto-Thai
    // is machine translation stacked on machine transcription.
    const thai = pickTrack(tracks, "th");
    if (thai && thai.kind !== "asr") return { ok: false, code: "native-thai" };

    const source = pickSourceTrack(tracks);
    if (!source) return { ok: false, code: "no-english" };
    log(
      "ภาษาต้นทางที่ตรวจพบ:",
      source.languageCode,
      source.kind === "asr" ? "(ถอดเสียงอัตโนมัติ)" : "(คนทำ)"
    );

    const data = await fetchTimedText(source);
    if (!data.ok) return data;

    const cues = groupCues(data.cues);
    if (!cues.length) return { ok: false, code: "caption-parse-failed" };
    return {
      ok: true,
      cues,
      replacingAutoThai: Boolean(thai),
      sourceLang: (source.languageCode || "").toUpperCase(),
    };
  },
};

UDTH.isYouTube = typeof location !== "undefined" && /(^|\.)youtube\.com$/.test(location.hostname);
