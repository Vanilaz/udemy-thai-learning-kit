// Shared study panel for the player and the standalone queue page.
var UDTH = window.UDTH || (window.UDTH = {});

UDTH.createWorkspace = function createWorkspace(options) {
  // How many lectures are being translated right now. The server runs several
  // at once, so the old "is there a running job? then 1" undercounted as soon
  // as more than one was in flight. `running_count` is missing on an older
  // server, where the presence of `running` is still the best answer available.
  function runningCount(info) {
    if (typeof info.running_count === "number") return info.running_count;
    return info.running ? 1 : 0;
  }

  const root = document.createElement("section");
  root.className = `hr-workspace${options.page ? " hr-workspace-page" : ""}`;
  root.hidden = !options.page;
  root.setAttribute("aria-label", "ฮองเรียน — บทเรียนและคิวแปล");
  root.innerHTML = `
    <header class="hr-head"><div><span class="hr-brand">ฮองเรียน</span><h2>บทเรียนและคิวแปล</h2></div>
      <button type="button" class="hr-close" aria-label="ปิดแผงบทเรียน">ปิด</button></header>
    <nav class="hr-tabs" aria-label="เลือกมุมมอง">
      <button type="button" data-view="transcript">Transcript</button>
      <button type="button" data-view="queue">คิวและประวัติ</button></nav>
    <section class="hr-transcript">
      <p class="hr-lesson"></p>
      <label class="hr-search-label">ค้นหาในบทเรียน<input type="search" class="hr-search" placeholder="คำศัพท์ ประโยคไทย หรือภาษาต้นฉบับ"></label>
      <p class="hr-count" role="status"></p>
      <div class="hr-cues"></div>
      <button type="button" class="hr-more">แสดงเพิ่ม</button>
    </section>
    <section class="hr-queue" hidden>
      <div class="hr-queue-toolbar"><span class="hr-queue-summary" role="status">กำลังอ่านคิว…</span><button type="button" class="hr-reload">รีเฟรช</button></div>
      <p class="hr-help">งานที่ค้างจะกลับเข้าคิวเมื่อเปิดเซิร์ฟเวอร์ใหม่ การยกเลิกงานที่เริ่มแล้วจะรอคำขอปัจจุบันจบ</p>
      <p class="hr-error" role="alert" hidden></p>
      <div class="hr-jobs"></div>
    </section>`;
  (options.host || document.body).appendChild(root);
  const find = (selector) => root.querySelector(selector);
  let view = options.page ? "queue" : "transcript";
  let limit = 80;
  let timer = null;
  let fetching = false;
  let lastJobs = "";
  let returnFocus = null;
  let busy = false;
  let disposed = false;
  function mount() {
    if (!options.page && !root.hidden) (document.fullscreenElement || document.body).appendChild(root);
  }
  document.addEventListener("fullscreenchange", mount);
  const labels = {queued: "รอแปล", running: "กำลังแปล", cancelling: "กำลังหยุด", cancelled: "ยกเลิกแล้ว", done: "เสร็จแล้ว", error: "ผิดพลาด"};

  function clock(value) {
    if (!Number.isFinite(value) || value < 0) return "ไม่มีเวลา";
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function renderTranscript() {
    const cues = options.getCues ? options.getCues() : [];
    const query = find(".hr-search").value.trim().toLocaleLowerCase();
    const matches = cues.filter(cue => `${cue.en || ""}\n${cue.th || ""}`.toLocaleLowerCase().includes(query));
    find(".hr-lesson").textContent = options.getTitle ? options.getTitle() : "";
    find(".hr-count").textContent = !cues.length
      ? "ซับยังไม่พร้อม เปิดวิดีโอแล้วรอคำแปล หรือดูสถานะในแท็บคิว"
      : !matches.length ? "ไม่พบข้อความ ลองใช้คำสั้นลงหรือล้างคำค้น"
        : `พบ ${matches.length} บรรทัด · คลิกเวลาเพื่อข้ามไปฟัง`;
    const fragment = document.createDocumentFragment();
    for (const cue of matches.slice(0, limit)) {
      const row = document.createElement("article");
      row.className = "hr-cue";
      const seek = document.createElement("button");
      seek.type = "button";
      seek.className = "hr-time";
      seek.textContent = clock(cue.start);
      seek.setAttribute("aria-label", `ข้ามไปเวลา ${clock(cue.start)}`);
      seek.disabled = !Number.isFinite(cue.start) || !options.seek;
      seek.addEventListener("click", () => options.seek(cue.start));
      const text = document.createElement("div");
      const th = document.createElement("p");
      th.className = "hr-th";
      th.textContent = cue.th || "กำลังรอคำแปล…";
      const en = document.createElement("p");
      en.className = "hr-en";
      en.textContent = cue.en || "";
      text.append(th, en);
      row.append(seek, text);
      fragment.append(row);
    }
    find(".hr-cues").replaceChildren(fragment);
    find(".hr-more").hidden = matches.length <= limit;
  }

  function error(message) {
    find(".hr-error").hidden = !message;
    find(".hr-error").textContent = message || "";
  }

  async function performAction(id, action, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = "กำลังส่ง…";
    try {
      const result = await options.send({type: "jobAction", jobId: id, action});
      if (!result || !result.ok) throw new Error(result?.error || "เปลี่ยนสถานะงานไม่สำเร็จ");
      error("");
    } catch (err) {
      error(String(err.message || err));
    } finally {
      busy = false;
      lastJobs = "";
      button.disabled = false;
      button.textContent = action === "cancel" ? "ยกเลิก" : "ลองใหม่";
      await refreshQueue(false);
    }
  }

  async function refreshQueue(clearError = true) {
    if (fetching || busy || disposed || root.hidden || view !== "queue") return;
    fetching = true;
    try {
      const response = await options.send({type: "queueStatus"});
      if (disposed) return;
      if (!response || !response.ok) throw new Error(response?.error || "ติดต่อเซิร์ฟเวอร์ไม่ได้ เปิด start-server.cmd แล้วลองอีกครั้ง");
      const info = response.data;
      if (!Array.isArray(info?.jobs)) throw new Error("เซิร์ฟเวอร์ยังเป็นเวอร์ชันเก่า ปิดแล้วเปิด start-server.cmd ใหม่");
      if (clearError) error("");
      find(".hr-queue-summary").textContent = `รอ ${info.queued || 0} · กำลังทำ ${runningCount(info)} · เสร็จ ${info.done || 0} · ผิดพลาด ${info.failed || 0}`;
      const serialized = JSON.stringify(info.jobs);
      if (serialized === lastJobs) return;
      lastJobs = serialized;
      const fragment = document.createDocumentFragment();
      if (!info.jobs.length) {
        const empty = document.createElement("p");
        empty.className = "hr-empty";
        empty.textContent = "ยังไม่มีงานแปล เปิดบทเรียน หรือเลือกแปลทั้ง Section เพื่อเริ่มคิว";
        fragment.append(empty);
      }
      for (const job of info.jobs) {
        const row = document.createElement("article");
        row.className = "hr-job";
        const heading = document.createElement("h3");
        heading.textContent = job.title;
        const meta = document.createElement("p");
        meta.className = "hr-job-meta";
        meta.textContent = `${job.course || "บทเรียน"} · ${labels[job.status] || job.status}`;
        const status = document.createElement("p");
        status.className = "hr-job-detail";
        status.textContent = job.status === "error" ? job.error || "แปลไม่สำเร็จ"
          : job.status === "cancelling" ? "จะหยุดหลังคำขอที่กำลังทำจบ โดยไม่บันทึกเป็นงานสำเร็จ"
          : job.phase === "repairing" && job.status === "running" ? `กำลังซ่อมคำแปลที่ขาด ${job.missing || 0} บรรทัด`
          : job.status === "running" && job.chunks ? `เสร็จ ${job.progress || 0}/${job.chunks} ช่วง`
          : job.resumed && job.status === "queued" ? "กลับเข้าคิวหลังเปิดเซิร์ฟเวอร์ใหม่" : "";
        row.append(heading, meta, status);
        const action = ["queued", "running"].includes(job.status) ? "cancel"
          : ["error", "cancelled"].includes(job.status) ? "retry" : null;
        if (action) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = action === "cancel" ? "ยกเลิก" : "ลองใหม่";
          button.setAttribute("aria-label", `${button.textContent}: ${job.title}`);
          button.addEventListener("click", () => performAction(job.id, action, button));
          row.append(button);
        }
        fragment.append(row);
      }
      const focusedLabel = root.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
      find(".hr-jobs").replaceChildren(fragment);
      if (focusedLabel) Array.from(find(".hr-jobs").querySelectorAll("button")).find(b => b.getAttribute("aria-label") === focusedLabel)?.focus();
    } catch (err) {
      find(".hr-queue-summary").textContent = "อัปเดตคิวไม่ได้ · ข้อมูลด้านล่างอาจเป็นข้อมูลเก่า";
      error(String(err.message || err));
    } finally {
      fetching = false;
    }
  }

  function select(next) {
    view = next;
    find(".hr-transcript").hidden = next !== "transcript";
    find(".hr-queue").hidden = next !== "queue";
    root.querySelectorAll("[data-view]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.view === next)));
    if (next === "transcript") renderTranscript();
    else refreshQueue();
  }
  function close() {
    root.hidden = true;
    clearInterval(timer);
    timer = null;
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function open(next = view) {
    returnFocus = document.activeElement;
    root.hidden = false;
    mount();
    select(next);
    clearInterval(timer);
    timer = setInterval(refreshQueue, 2000);
    if (!options.page) find(next === "transcript" ? ".hr-search" : '[data-view="queue"]').focus();
  }
  find(".hr-close").hidden = Boolean(options.page);
  find('[data-view="transcript"]').hidden = Boolean(options.page);
  root.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => select(b.dataset.view)));
  root.addEventListener("click", event => event.stopPropagation());
  root.addEventListener("keydown", event => {
    event.stopPropagation();
    if (event.key === "Escape" && !options.page) { event.preventDefault(); close(); }
  });
  find(".hr-close").addEventListener("click", close);
  find(".hr-search").addEventListener("input", () => { limit = 80; renderTranscript(); });
  find(".hr-more").addEventListener("click", () => { limit += 80; renderTranscript(); });
  find(".hr-reload").addEventListener("click", () => refreshQueue());
  if (options.page) open("queue");
  return {
    open,
    refresh() { if (!root.hidden && view === "transcript") renderTranscript(); },
    reset() { find(".hr-search").value = ""; limit = 80; renderTranscript(); },
    destroy() { disposed = true; clearInterval(timer); document.removeEventListener("fullscreenchange", mount); root.remove(); },
  };
};
