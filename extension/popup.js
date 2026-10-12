// Popup: server status, the same settings as the in-player menu, and actions.
//
// Settings are read and written through core/settings.js, the store the page
// uses too, so the two can never disagree; the page hears each change itself.
"use strict";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const hintEl = $("hint");
const enabledEl = $("enabled");
const dualEl = $("dual");
const dubbingEl = $("dubbing");
const audioSettingsEl = $("audioSettings");
const ttsEngineEl = $("ttsEngine");
const voiceEl = $("voice");
const startFieldEl = $("startField");
const startHintEl = $("startHint");
const dubbingVolumeEl = $("dubbingVolume");
const originalAudioVolumeEl = $("originalAudioVolume");
const dubbingValueEl = $("dubbingValue");
const originalAudioValueEl = $("originalAudioValue");
const sectionEl = $("section");
const retryEl = $("retry");
const queueEl = $("queue");
const queueTitleEl = $("queueTitle");
const queueDetailEl = $("queueDetail");
const queueFillEl = $("queueFill");

const t = (text, vars) => UDTH.i18n.t(text, vars);
const store = UDTH.settings.createSettingsStore({ area: chrome.storage.local, onChanged: chrome.storage.onChanged });
const api = UDTH.api.createApi((message) => chrome.runtime.sendMessage(message));
const browserEngine = () => ({ name: "windows", label: t("Windows (เสียงในเบราว์เซอร์)"), ready: true, translates: false, voices: [] });
const VIDEO_PAGE = /https:\/\/(www\.)?(udemy\.com\/course\/|youtube\.com\/(watch|shorts))/;

let engines = [];
let shownLang = null;
let queuePeak = 0;
let queueBusy = false;

const catalogue = () => [browserEngine(), ...engines.map(UDTH.i18n.localizeEngine)];
const engineByName = (name) => catalogue().find((e) => e.name === name);

function browserVoices() {
  return speechSynthesis
    .getVoices()
    .filter((v) => /^th(?:-|_)/i.test(v.lang))
    .map((v) => ({ id: v.name, label: v.name }));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function fill(select, options, selected) {
  select.textContent = "";
  for (const o of options) select.add(new Option(o.label, o.value));
  select.value = options.some((o) => o.value === selected) ? selected : options.length ? options[0].value : "";
}

// Static text is marked in popup.html; its Thai source is kept on the element
// so switching back and forth always starts from the original.
function localize() {
  const source = (el, read) => (el.dataset.i18nSrc = el.dataset.i18nSrc || read(el));
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(source(el, (e) => e.textContent.trim()));
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(source(el, (e) => e.innerHTML.trim()));
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(source(el, (e) => e.getAttribute("aria-label"))));
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === UDTH.i18n.lang()));
  }
}

/** Apply the chosen language; true when the words on screen changed. */
function applyLang(settings) {
  const lang = UDTH.i18n.setLang(settings.lang);
  if (lang === shownLang) return false;
  shownLang = lang;
  localize();
  return true;
}

function render(settings) {
  const dub = settings.dub;
  enabledEl.checked = settings.subtitles !== "off";
  dualEl.checked = settings.subtitles === "both";
  dualEl.disabled = settings.subtitles === "off";
  dubbingEl.checked = dub.on;
  audioSettingsEl.hidden = !dub.on;

  const engineOptions = catalogue().map((e) => ({ value: e.name, label: e.ready ? e.label : t("{engine} (ยังไม่พร้อม)", { engine: e.label }) }));
  if (!engineByName(dub.engine)) {
    engineOptions.push({ value: dub.engine, label: t("{engine} (ยังไม่พร้อม)", { engine: dub.engine }) });
  }
  fill(ttsEngineEl, engineOptions, dub.engine);

  const engine = engineByName(dub.engine);
  const voices = dub.engine === "windows" ? browserVoices() : (engine && engine.voices) || [];
  fill(voiceEl, voices.length ? voices.map((v) => ({ value: v.id, label: v.label })) : [{ value: "", label: t("เลือกอัตโนมัติ") }], dub.voice);

  startFieldEl.hidden = !(engine && engine.translates);
  for (const button of startFieldEl.querySelectorAll("[data-start]")) {
    button.setAttribute("aria-pressed", String(button.dataset.start === dub.start));
  }
  startHintEl.textContent =
    dub.start === "instant"
      ? t("เล่นได้ทันที Seamless แปลและพากย์จากต้นฉบับ แล้วเปลี่ยนเป็นคำแปล AI เมื่อแปลเสร็จ")
      : t("รอ AI แปลก่อนราว 1 นาที ซับและเสียงตรงกันทุกคำ แม่นที่สุด");

  dubbingVolumeEl.value = String(dub.volume);
  dubbingValueEl.value = `${Math.round(dub.volume * 100)}%`;
  originalAudioVolumeEl.value = String(dub.sourceVolume);
  originalAudioValueEl.value = `${Math.round(dub.sourceVolume * 100)}%`;
}

function setStatus(text, ok) {
  statusEl.className = ok ? "status ok" : "status";
  statusEl.textContent = text;
}

async function refreshServer() {
  const mine = chrome.runtime.getManifest().version;
  try {
    const health = await api.health();
    engines = health.engines;
    if (health.version && health.version !== mine) {
      setStatus(
        t("เซิร์ฟเวอร์เป็นเวอร์ชัน {server} แต่ส่วนขยายเป็น {mine} ปิดแล้วเปิด start-server.cmd ใหม่", {
          server: health.version,
          mine,
        }),
        false
      );
    } else if (!health.version) {
      setStatus(t("เซิร์ฟเวอร์เป็นเวอร์ชันเก่า ปิดแล้วเปิด start-server.cmd ใหม่"), false);
    } else {
      setStatus(t("เซิร์ฟเวอร์พร้อมทำงาน"), true);
    }
    hintEl.textContent = t("เปิดวิดีโอใน Udemy หรือ YouTube ได้เลย ครั้งแรกของแต่ละบทจะใช้เวลาแปลสักครู่");
  } catch (error) {
    engines = [];
    setStatus(error.message, false);
    hintEl.innerHTML = t("ดับเบิลคลิก <code>start-server.cmd</code> ในโฟลเดอร์โปรเจกต์ แล้วเปิดหน้านี้ใหม่");
  }
}

// What the lecture in the active tab is doing, in one line.
async function refreshLecture() {
  const tab = await activeTab();
  const onVideoPage = Boolean(tab && VIDEO_PAGE.test(tab.url || ""));
  const onUdemy = Boolean(tab && /udemy\.com\/course\//.test(tab.url || ""));
  sectionEl.disabled = !onUdemy || !engines.length;
  if (!onVideoPage) return;
  let state;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: "getState" });
  } catch {
    hintEl.textContent = t("หน้าวิดีโอนี้ยังไม่มีส่วนขยายทำงาน กด F5 รีเฟรชหน้าวิดีโอหนึ่งครั้ง");
    return;
  }
  if (!state || !engines.length) return;
  const lang = state.sourceLang ? t("{lang} → ไทย", { lang: state.sourceLang.split("-")[0].toUpperCase() }) : "";
  if (state.phase === "playing") {
    setStatus(
      state.translating
        ? t("กำลังเล่น {lang} · ส่วนที่เหลือกำลังแปล", { lang })
        : t("กำลังเล่น {lang} · แปลครบแล้ว", { lang }),
      true
    );
  } else if (state.phase === "waiting") {
    setStatus(t("กำลังเตรียมบทนี้ {lang}", { lang }), true);
  } else if (state.phase === "error") {
    setStatus(state.message, false);
  }
}

// How many lectures are being translated right now. `running_count` is missing
// on an older server, where the presence of `running` is the best answer.
function runningCount(info) {
  if (typeof info.running_count === "number") return info.running_count;
  return info.running ? 1 : 0;
}

async function refreshQueue() {
  if (queueBusy) return;
  queueBusy = true;
  let info = null;
  try {
    info = await api.queue();
  } catch {
    /* server unreachable: leave the panel as it is */
  } finally {
    queueBusy = false;
  }
  if (!info) {
    queueEl.style.display = "none";
    return;
  }
  const left = (info.queued || 0) + runningCount(info);
  if (!left) {
    // Only worth reporting a finished queue if this popup watched it run.
    if (!queuePeak) {
      queueEl.style.display = "none";
      return;
    }
    queueEl.style.display = "";
    queueTitleEl.textContent = info.failed
      ? t("แปลล่วงหน้าเสร็จ พลาด {failed} บทเรียน", { failed: info.failed })
      : t("แปลล่วงหน้าเสร็จแล้ว");
    queueDetailEl.textContent = "";
    queueFillEl.style.width = "100%";
    return;
  }
  queuePeak = Math.max(queuePeak, left);
  const done = queuePeak - left;
  queueEl.style.display = "";
  queueTitleEl.textContent = t("กำลังแปลล่วงหน้า {done}/{total} บทเรียน", { done, total: queuePeak });
  queueDetailEl.textContent = info.running ? info.running.title : "";
  queueFillEl.style.width = `${(done / queuePeak) * 100}%`;
}

// ------------------------------------------------------------------ inputs

enabledEl.addEventListener("change", () =>
  store.save({ subtitles: enabledEl.checked ? (dualEl.checked ? "both" : "th") : "off" })
);
dualEl.addEventListener("change", () => store.save({ subtitles: dualEl.checked ? "both" : "th" }));
dubbingEl.addEventListener("change", () => store.save({ dub: { on: dubbingEl.checked } }));
ttsEngineEl.addEventListener("change", () => store.save({ dub: { engine: ttsEngineEl.value } }));
voiceEl.addEventListener("change", () => store.save({ dub: { voice: voiceEl.value } }));
dubbingVolumeEl.addEventListener("input", () => store.save({ dub: { volume: Number(dubbingVolumeEl.value) } }));
originalAudioVolumeEl.addEventListener("input", () =>
  store.save({ dub: { sourceVolume: Number(originalAudioVolumeEl.value) } })
);
for (const button of startFieldEl.querySelectorAll("[data-start]")) {
  button.addEventListener("click", () => store.save({ dub: { start: button.dataset.start } }));
}
for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => store.save({ lang: button.dataset.lang }));
}

retryEl.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.url) return;
  // Reloading wipes the page's memory, so "ignore the cache" is left in
  // storage, keyed by lecture so it cannot leak into a different one.
  const lecture =
    (tab.url.match(/\/learn\/lecture\/(\d+)/) || [])[1] ||
    (tab.url.match(/[?&]v=([\w-]{11})/) || [])[1] ||
    (tab.url.match(/\/shorts\/([\w-]{11})/) || [])[1];
  if (lecture) await chrome.storage.local.set({ forceLecture: lecture });
  chrome.tabs.reload(tab.id);
  window.close();
});

sectionEl.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab) return;
  sectionEl.disabled = true;
  const original = sectionEl.lastChild.textContent;
  sectionEl.lastChild.textContent = t("กำลังเตรียมคิว ...");
  try {
    // The page answers immediately and keeps gathering in the background, so
    // closing this popup does not cancel anything.
    const res = await chrome.tabs.sendMessage(tab.id, { type: "translateSection" });
    if (res && res.ok) {
      sectionEl.lastChild.textContent = t("ส่งเข้าคิวแล้ว");
      hintEl.textContent = t("ดูความคืบหน้าได้ที่มุมซ้ายล่างของหน้า Udemy เปลี่ยนบทเรียนระหว่างนี้ได้");
      return;
    }
    setStatus((res && res.error) || t("สั่งแปลทั้ง Section ไม่สำเร็จ"), false);
  } catch {
    setStatus(t("หน้านี้ยังไม่พร้อม กด F5 รีเฟรชหน้า Udemy หนึ่งครั้ง"), false);
  }
  sectionEl.disabled = false;
  sectionEl.lastChild.textContent = original;
});

// ------------------------------------------------------------------ start

document.querySelector(".version").textContent = `v${chrome.runtime.getManifest().version}`;
speechSynthesis.addEventListener("voiceschanged", () => store.get() && render(store.get()));
store.subscribe((settings) => {
  const relabelled = applyLang(settings);
  render(settings);
  // Messages already on screen were written in the old language.
  if (relabelled) refreshServer().then(() => refreshLecture());
});
store.load().then(async (settings) => {
  applyLang(settings);
  render(settings);
  await refreshServer();
  render(store.get());
  refreshLecture();
});
refreshQueue();
setInterval(refreshQueue, 2000);
