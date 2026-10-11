// Popup: shows whether the local server is up and toggles overlay options.

const statusEl = document.getElementById("status");
const enabledEl = document.getElementById("enabled");
const dualEl = document.getElementById("dual");
const dubbingEl = document.getElementById("dubbing");
const ttsEngineEl = document.getElementById("ttsEngine");
const voiceEl = document.getElementById("voice");
const dubSourceEl = document.getElementById("dubSource");
const dubSourceFieldEl = document.getElementById("dubSourceField");
const dubbingVolumeEl = document.getElementById("dubbingVolume");
const originalAudioVolumeEl = document.getElementById("originalAudioVolume");
const audioSettingsEl = document.getElementById("audioSettings");
const dubbingValueEl = document.getElementById("dubbingValue");
const originalAudioValueEl = document.getElementById("originalAudioValue");
const retryEl = document.getElementById("retry");
const sectionEl = document.getElementById("section");
const hintEl = document.getElementById("hint");
const managerEl = document.getElementById("manager");
const queueEl = document.getElementById("queue");
const queueTitleEl = document.getElementById("queueTitle");
const queueDetailEl = document.getElementById("queueDetail");
const queueFillEl = document.getElementById("queueFill");

// Peak queue length seen while this popup is open, so the bar has something to
// measure against — the server only reports what is still waiting.
let queuePeak = 0;
let knownNativeVoices = [];
// Set while a queue poll is in flight, so a slow server cannot stack polls.
let queueBusy = false;

// A message to a dead service worker or a tab without our content script can
// hang forever; the popup must still settle into a readable state.
function withTimeout(promise, milliseconds = 4000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("การเชื่อมต่อใช้เวลานานเกินไป ลองเปิดหน้าต่างนี้ใหม่")), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

// The choice only means something for an engine that can translate on its
// own (Seamless); for every other engine the dub is always the AI's Thai.
function syncDubSource() {
  const engine = allEngines().find((e) => e.name === ttsEngineEl.value);
  dubSourceFieldEl.hidden = !(engine && engine.translates);
}

function syncAudioControls() {
  audioSettingsEl.hidden = !dubbingEl.checked;
  dubbingValueEl.value = `${Math.round(Number(dubbingVolumeEl.value) * 100)}%`;
  originalAudioValueEl.value = `${Math.round(Number(originalAudioVolumeEl.value) * 100)}%`;
}

// The browser's own voices are one engine among several; the rest are read
// from the server, so installing a new speech engine there is enough to make
// it appear here.
const BROWSER_ENGINE = {
  name: "windows",
  label: "Windows Natural (ในเบราว์เซอร์)",
  ready: true,
  voices: [],
};
let serverEngines = [];

function allEngines() {
  return [BROWSER_ENGINE, ...serverEngines];
}

function fillEngineOptions(selected) {
  ttsEngineEl.innerHTML = "";
  for (const engine of allEngines()) {
    // Listed with its reason when unusable rather than hidden, so a supported
    // option never looks like it does not exist.
    const suffix = engine.ready ? "" : " — ยังตั้งค่าไม่ครบ";
    ttsEngineEl.add(new Option(engine.label + suffix, engine.name));
  }
  // The saved engine may not be in the catalogue — stored before the server was
  // restarted, or the server is down. Keep it rather than showing a blank box.
  if (![...ttsEngineEl.options].some((o) => o.value === selected)) {
    ttsEngineEl.add(new Option(`${selected} — ยังไม่พร้อมใช้`, selected));
  }
  ttsEngineEl.value = selected;
}

function fillVoiceOptions(engineName, nativeVoices, selected) {
  const engine = allEngines().find((e) => e.name === engineName) || BROWSER_ENGINE;
  const voices =
    engineName === "windows"
      ? (nativeVoices || []).map((voice) => ({ id: voice.name, label: voice.name }))
      : engine.voices || [];

  voiceEl.innerHTML = "";
  if (!voices.length) {
    voiceEl.add(
      new Option(
        engineName === "windows"
          ? "เลือกอัตโนมัติ (รอ Windows โหลดเสียง)"
          : "เครื่องมือนี้ยังใช้ไม่ได้",
        ""
      )
    );
  } else {
    voices.forEach((voice) => voiceEl.add(new Option(voice.label, voice.id)));
  }
  if ([...voiceEl.options].some((option) => option.value === selected)) voiceEl.value = selected;
  else if (voiceEl.options.length) voiceEl.selectedIndex = 0;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  let health;
  try {
    health = await withTimeout(chrome.runtime.sendMessage({ type: "health" }));
  } catch (error) {
    health = { ok: false, error: error.message };
  }

  if (health && health.ok) {
    serverEngines = health.voices || [];
    statusEl.className = "status ok";
    statusEl.textContent = `เซิร์ฟเวอร์ทำงานอยู่ (${health.engine})`;
    hintEl.textContent = "เปิดวิดีโอใน Udemy หรือ YouTube ได้เลย ครั้งแรกของแต่ละบทจะใช้เวลาแปลสักครู่";
  } else {
    statusEl.className = "status";
    statusEl.textContent = "ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
    hintEl.innerHTML =
      "ดับเบิลคลิก <code>start-server.cmd</code> ในโฟลเดอร์โปรเจกต์ แล้วเปิดหน้านี้ใหม่";
  }

  const tab = await activeTab();
  const url = (tab && tab.url) || "";
  const onUdemy = url.includes("udemy.com/course/");
  const onVideoPage = onUdemy || /youtube\.com\/(watch|shorts)/.test(url);
  // Pre-translating a whole section is a Udemy idea; YouTube has no curriculum
  // to walk. And nothing can be queued at all while the server is down.
  sectionEl.disabled = !onUdemy || !(health && health.ok);

  if (!onVideoPage) return;

  try {
    const state = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "getState" }), 2500);
    if (state) {
      enabledEl.checked = state.enabled;
      dualEl.checked = state.dualMode;
      dubbingEl.checked = Boolean(state.dubbingEnabled);
      knownNativeVoices = state.nativeVoices || [];
      fillEngineOptions(state.ttsEngine || "edge");
      fillVoiceOptions(ttsEngineEl.value, knownNativeVoices, state.ttsVoice);
      if (state.dubSource) dubSourceEl.value = state.dubSource;
      syncDubSource();
      dubbingVolumeEl.value = String(state.dubbingVolume ?? 1);
      originalAudioVolumeEl.value = String(state.originalAudioVolume ?? 0.15);
      syncAudioControls();
      if (health && health.ok && state.status === "ready") {
        const engine = allEngines().find((e) => e.name === state.ttsEngine);
        if (!state.dubbingEnabled) {
          statusEl.textContent = `พร้อมแล้ว — ซับไทย ${state.count} บรรทัด`;
        } else if (engine && !engine.ready) {
          statusEl.className = "status";
          statusEl.textContent = `${engine.label} ยังไม่พร้อม — ${engine.error}`;
        } else if (state.ttsEngine === "windows") {
          statusEl.textContent = "Windows Natural พร้อมพากย์ไทย";
        } else {
          // "0 ประโยค" read like a failure before playback had even begun;
          // say what is on, and mention the buffer only while it is working.
          const pending = state.audioPending || 0;
          const name = engine ? engine.label.replace(/\s*\(.*\)\s*$/, "") : state.ttsEngine;
          statusEl.textContent =
            `พร้อมแล้ว — พากย์ด้วย ${name}` + (pending ? ` · กำลังเตรียมเสียง ${pending} ประโยค` : "");
        }
      }
    }
  } catch {
    // Content script not loaded on this page — nothing to sync.
  }
}

// How many lectures are being translated right now. The server runs several
// at once, so the old "is there a running job? then 1" undercounted as soon
// as more than one was in flight. `running_count` is missing on an older
// server, where the presence of `running` is still the best answer available.
function runningCount(info) {
  if (typeof info.running_count === "number") return info.running_count;
  return info.running ? 1 : 0;
}

async function refreshQueue() {
  if (queueBusy) return;
  queueBusy = true;
  let info = null;
  try {
    const res = await withTimeout(chrome.runtime.sendMessage({ type: "queueStatus" }));
    if (res && res.ok) info = res.data;
  } catch {
    /* server or worker unreachable — leave the panel as it is */
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
      ? `แปลล่วงหน้าเสร็จ — พลาด ${info.failed} บทเรียน`
      : "แปลล่วงหน้าเสร็จแล้ว";
    queueDetailEl.textContent = "";
    queueFillEl.style.width = "100%";
    return;
  }

  queuePeak = Math.max(queuePeak, left);
  const done = queuePeak - left;
  queueEl.style.display = "";
  queueTitleEl.textContent = `กำลังแปลล่วงหน้า ${done}/${queuePeak} บทเรียน`;
  queueDetailEl.textContent = info.running ? info.running.title : "";
  queueFillEl.style.width = `${(done / queuePeak) * 100}%`;
}

async function pushOptions() {
  const options = {
    enabled: enabledEl.checked,
    dualMode: dualEl.checked,
    dubbingEnabled: dubbingEl.checked,
    ttsEngine: ttsEngineEl.value,
    ttsVoice: voiceEl.value,
    dubSource: dubSourceEl.value,
    dubbingVolume: Number(dubbingVolumeEl.value),
    originalAudioVolume: Number(originalAudioVolumeEl.value),
  };
  await chrome.storage.local.set(options);
  const tab = await activeTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "setOptions", ...options }).catch(() => {});
}

enabledEl.addEventListener("change", pushOptions);
dualEl.addEventListener("change", pushOptions);
dubbingEl.addEventListener("change", pushOptions);
dubbingEl.addEventListener("change", syncAudioControls);
ttsEngineEl.addEventListener("change", () => {
  fillVoiceOptions(ttsEngineEl.value, knownNativeVoices, "");
  syncDubSource();
  pushOptions();
});
voiceEl.addEventListener("change", pushOptions);
dubSourceEl.addEventListener("change", pushOptions);
dubbingVolumeEl.addEventListener("input", () => { syncAudioControls(); pushOptions(); });
originalAudioVolumeEl.addEventListener("input", () => { syncAudioControls(); pushOptions(); });

retryEl.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.url) return;

  // Reloading wipes the content script's memory, so the "ignore the cache"
  // request has to be left somewhere that survives — keyed by lecture so it
  // can't leak into a different one.
  const lecture =
    (tab.url.match(/\/learn\/lecture\/(\d+)/) || [])[1] ||
    (tab.url.match(/[?&]v=([\w-]+)/) || [])[1];
  if (lecture) await chrome.storage.local.set({ forceLecture: lecture });

  await chrome.tabs.sendMessage(tab.id, { type: "retranslate" }).catch(() => {});
  chrome.tabs.reload(tab.id);
  window.close();
});

// The queue page is an extension page, so it opens in a tab of its own rather
// than in this popup — it is a place to read history, not a control you reach
// for mid-sentence.
if (managerEl) {
  managerEl.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
    window.close();
  });
}

sectionEl.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab) return;

  sectionEl.disabled = true;
  const original = sectionEl.textContent;
  sectionEl.textContent = "กำลังเตรียมคิว ...";

  try {
    // The content script answers immediately and keeps gathering in the
    // background, so closing this popup does not cancel anything.
    const res = await chrome.tabs.sendMessage(tab.id, { type: "translateSection" });
    if (res && res.ok) {
      sectionEl.textContent = "ส่งเข้าคิวแล้ว";
      hintEl.textContent =
        "ดูความคืบหน้าได้ที่มุมซ้ายล่างของหน้า Udemy — เปลี่ยนบทเรียนระหว่างนี้ได้";
    } else {
      sectionEl.disabled = false;
      sectionEl.textContent = original;
      statusEl.className = "status";
      statusEl.textContent = (res && res.error) || "สั่งแปลทั้ง Section ไม่สำเร็จ";
    }
  } catch {
    sectionEl.disabled = false;
    sectionEl.textContent = original;
    statusEl.className = "status";
    statusEl.textContent = "หน้านี้ยังไม่พร้อม — กด F5 รีเฟรชหน้า Udemy หนึ่งครั้ง";
  }
});

refresh();
refreshQueue();
setInterval(refreshQueue, 2000);

(() => {
  const el = document.querySelector(".version");
  if (el) el.textContent = `v${chrome.runtime.getManifest().version}`;
})();
