// Popup: shows whether the local server is up and toggles overlay options.

const statusEl = document.getElementById("status");
const enabledEl = document.getElementById("enabled");
const dualEl = document.getElementById("dual");
const retryEl = document.getElementById("retry");
const sectionEl = document.getElementById("section");
const hintEl = document.getElementById("hint");
const queueEl = document.getElementById("queue");
const queueTitleEl = document.getElementById("queueTitle");
const queueDetailEl = document.getElementById("queueDetail");
const queueFillEl = document.getElementById("queueFill");

// Peak queue length seen while this popup is open, so the bar has something to
// measure against — the server only reports what is still waiting.
let queuePeak = 0;

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
  const onCoursePage = Boolean(
    tab && tab.url && tab.url.includes("udemy.com/course/")
  );
  // Nothing to queue from a page that is not a lecture, and nothing to queue
  // onto if the server is down.
  sectionEl.disabled = !onCoursePage || !(health && health.ok);

  if (!onCoursePage) return;

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

async function refreshQueue() {
  let info = null;
  try {
    const res = await chrome.runtime.sendMessage({ type: "queueStatus" });
    if (res && res.ok) info = res.data;
  } catch {
    /* server or worker unreachable — leave the panel as it is */
  }

  if (!info) {
    queueEl.style.display = "none";
    return;
  }

  const left = (info.queued || 0) + (info.running ? 1 : 0);
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
