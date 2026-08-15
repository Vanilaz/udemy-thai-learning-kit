// Popup: shows whether the local server is up and toggles overlay options.

const statusEl = document.getElementById("status");
const enabledEl = document.getElementById("enabled");
const dualEl = document.getElementById("dual");
const retryEl = document.getElementById("retry");
const hintEl = document.getElementById("hint");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const health = await chrome.runtime.sendMessage({ type: "health" });

  if (health && health.ok) {
    statusEl.className = "status ok";
    statusEl.textContent = `เซิร์ฟเวอร์ทำงานอยู่ (${health.engine})`;
    hintEl.textContent = "เปิดวิดีโอใน Udemy ได้เลย ครั้งแรกของแต่ละบทจะใช้เวลาแปลสักครู่";
  } else {
    statusEl.className = "status";
    statusEl.textContent = "ยังไม่ได้เปิดเซิร์ฟเวอร์แปล";
    hintEl.innerHTML =
      "ดับเบิลคลิก <code>start-server.cmd</code> ในโฟลเดอร์โปรเจกต์ แล้วเปิดหน้านี้ใหม่";
  }

  const tab = await activeTab();
  if (!tab || !tab.url || !tab.url.includes("udemy.com/course/")) return;

  try {
    const state = await chrome.tabs.sendMessage(tab.id, { type: "getState" });
    if (state) {
      enabledEl.checked = state.enabled;
      dualEl.checked = state.dualMode;
      if (health && health.ok && state.status === "ready") {
        statusEl.textContent = `พร้อมแล้ว — ซับไทย ${state.count} บรรทัด`;
      }
    }
  } catch {
    // Content script not loaded on this page — nothing to sync.
  }
}

async function pushOptions() {
  const options = { enabled: enabledEl.checked, dualMode: dualEl.checked };
  await chrome.storage.local.set(options);
  const tab = await activeTab();
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: "setOptions", ...options }).catch(() => {});
}

enabledEl.addEventListener("change", pushOptions);
dualEl.addEventListener("change", pushOptions);

retryEl.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.url) return;

  // Reloading wipes the content script's memory, so the "ignore the cache"
  // request has to be left somewhere that survives — keyed by lecture so it
  // can't leak into a different one.
  const lecture = (tab.url.match(/\/learn\/lecture\/(\d+)/) || [])[1];
  if (lecture) await chrome.storage.local.set({ forceLecture: lecture });

  await chrome.tabs.sendMessage(tab.id, { type: "retranslate" }).catch(() => {});
  chrome.tabs.reload(tab.id);
  window.close();
});

refresh();
