// Entry point on Udemy and YouTube pages: wires the modules together.
//
//   site (sites.js / sites/udemy.js)  what is on this page, and its captions
//   session (pipeline/session.js)     one lecture: hold, translate, dub
//   overlay, menu, gate (ui/)         what the viewer sees
//   settings, api (core/)             what the viewer chose, and the server
//
// This file decides nothing about translation or dubbing itself; it starts a
// session per lecture, and turns session states into words on the screen.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});
  // Re-injection (an extension reload) must not start a second copy.
  if (UDTH.__mainStarted) return;
  UDTH.__mainStarted = true;

  const log = (...args) => console.log("[udth]", ...args);
  // One line per running copy: two of these on one page load means the
  // content scripts were injected twice (seen once, not yet explained).
  log(`ส่วนขยายเริ่มทำงาน v${chrome.runtime.getManifest().version}`, Math.random().toString(36).slice(2, 7));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const site = UDTH.isYouTube ? UDTH.youtube : UDTH.udemy;
  const store = UDTH.settings.createSettingsStore({ area: chrome.storage.local, onChanged: chrome.storage.onChanged });
  const api = UDTH.api.createApi((message) => chrome.runtime.sendMessage(message));

  const MAX_RETRIES = 3;
  const SKIP_TEXT = {
    "native-thai": "บทนี้มีซับไทยที่คนแปลไว้แล้ว กด CC แล้วเลือกภาษาไทย จะดีกว่าให้ AI แปล",
    "no-english": "บทนี้ไม่มีคำบรรยายต้นฉบับให้แปล",
    "no-captions": "วิดีโอนี้ไม่มีคำบรรยายเลย จึงแปลไม่ได้",
    "caption-blocked": "YouTube ไม่ยอมส่งไฟล์คำบรรยายมา ลองเปิด CC บนวิดีโอสักครั้งแล้วกด F5",
    "caption-no-token": "ขอ token จาก YouTube ไม่ได้ เล่นวิดีโอสักครู่ กดปุ่ม CC หนึ่งครั้ง แล้วกด F5",
    "caption-fetch-failed": "โหลดไฟล์คำบรรยายไม่สำเร็จ",
    "caption-parse-failed": "อ่านไฟล์คำบรรยายไม่ได้",
    "empty-article": "บทความนี้ไม่มีเนื้อหาให้แปล",
    "code-only": "บทความนี้มีแต่โค้ด ไม่มีข้อความให้แปล",
  };

  // ------------------------------------------------------------ server state

  let engines = [];
  let serverIssue = "";
  let serverVersion = "";

  async function refreshEngines() {
    try {
      const health = await api.health();
      engines = health.engines;
      serverVersion = health.version;
      serverIssue = "";
      // A server left running from an older version behaves differently, and
      // that looked exactly like a bug in this version. Name it instead.
      const mine = chrome.runtime.getManifest().version;
      if (serverVersion && serverVersion !== mine) {
        serverIssue = `เซิร์ฟเวอร์เป็นเวอร์ชัน ${serverVersion} แต่ส่วนขยายเป็น ${mine} ปิดแล้วเปิด start-server.cmd ใหม่`;
      } else if (!serverVersion) {
        serverIssue = "เซิร์ฟเวอร์เป็นเวอร์ชันเก่า ปิดแล้วเปิด start-server.cmd ใหม่";
      }
    } catch (error) {
      engines = [];
      serverIssue = error.message;
    }
  }

  function makeVoice(dub, catalogue) {
    if (dub.engine === "windows") return UDTH.voices.createBrowserVoice({ voiceName: dub.voice });
    const engine = catalogue.find((e) => e.name === dub.engine);
    const voiceId = UDTH.voices.resolveVoiceId(dub, engine);
    return UDTH.voices.createServerVoice({ api, voiceId, translates: Boolean(engine && engine.translates) });
  }

  // "แปลใหม่" reloads the page, so the request survives in storage, keyed by
  // lecture and consumed on read so it applies once.
  async function takeForceFlag(id) {
    if (!id) return false;
    try {
      const stored = await chrome.storage.local.get("forceLecture");
      if (stored.forceLecture && String(stored.forceLecture) === String(id)) {
        await chrome.storage.local.remove("forceLecture");
        return true;
      }
    } catch {
      /* storage unavailable: use the cache */
    }
    return false;
  }

  async function retranslate() {
    const id = site.cacheId();
    if (id) await chrome.storage.local.set({ forceLecture: String(id) }).catch(() => {});
    location.reload();
  }

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((v) => v.duration > 1) || videos[0] || null;
  }

  // The player mounts well after document_idle (about 14s on a real lecture
  // page). Poll rather than guess a delay.
  async function waitForVideo(timeoutMs, isCurrent) {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline && isCurrent()) {
      const video = findVideo();
      if (video && video.readyState >= 1) return video;
      if (!announced) {
        log("รอตัวเล่นวิดีโอ ...");
        announced = true;
      }
      await sleep(700);
    }
    return null;
  }

  // ------------------------------------------------------------- page state

  const page = {
    key: null,
    generation: 0,
    session: null,
    video: null,
    overlay: null,
    menu: null,
    state: { phase: "idle" },
    announcedReady: false,
  };

  const gate = UDTH.gateView.createGateView({ onSkip: () => page.session && page.session.skipWait() });

  // State the Udemy page modes keep between calls (quiz map, observers, batch).
  const pagesState = {
    status: "idle", quizMap: null, quizObserver: null, assignmentObserver: null, generation: 0,
    batch: { preparing: false, timer: null, total: 0, label: "" },
    get enabled() {
      return store.get() ? store.get().subtitles !== "off" : true;
    },
  };

  const pages = UDTH.udemyPages
    ? UDTH.udemyPages.createUdemyPages({
        state: pagesState,
        api,
        log,
        sleep,
        SKIP_TEXT,
        Stale: UDTH.api.Stale,
        getJson: UDTH.util.getJson,
        takeForceFlag,
        describeTranslateError: (err) => String((err && err.message) || err),
        showGate: (title, detail = "", kind = "info") =>
          gate.show({ title, detail, error: kind === "error", skippable: false }),
        hideGate: () => gate.hide(),
        assertCurrent: (generation) => {
          if (generation !== pagesState.generation) throw new UDTH.api.Stale();
        },
        requestTranslation: (payload, generation, onProgress, onPartial) =>
          api.translate(payload, { onProgress, onPartial, isCurrent: () => generation === pagesState.generation }),
      })
    : null;

  // -------------------------------------------------------- session -> view

  function waitingView(waitingFor) {
    const steps = [];
    let progress = null;
    const t = waitingFor.translation;
    if (t) {
      steps.push(
        t.total
          ? `แปลซับ: พร้อมแล้ว ${t.readySeconds}/${t.neededSeconds} วินาที (ท่อน ${t.done}/${t.total})`
          : `แปลซับ: พร้อมแล้ว ${t.readySeconds}/${t.neededSeconds} วินาที`
      );
      progress = Math.min(1, t.readySeconds / t.neededSeconds);
    }
    if (waitingFor.voice) {
      const engine = engines.find((e) => e.name === waitingFor.voice.engine);
      steps.push(`โหลดเสียงพากย์ ${engine ? engine.label : waitingFor.voice.engine} ขึ้นการ์ดจอ`);
    }
    const title = t && waitingFor.voice ? "กำลังเตรียมซับและเสียงพากย์ ..." : t ? "กำลังแปลเป็นไทย ..." : "กำลังโหลดเสียงพากย์ ...";
    const detail = t
      ? "วิดีโอจะเล่นต่อเองเมื่อแปลล่วงหน้าพอ ที่เหลือแปลต่อเบื้องหลัง"
      : "ครั้งแรกหลังเปิดเซิร์ฟเวอร์ใช้เวลาราว 15-60 วินาที วิดีโอจะเล่นต่อเองเมื่อพร้อม";
    return { title, steps, detail, progress };
  }

  function onSessionState(state) {
    page.state = state;
    const settings = store.get();
    if (state.phase === "waiting") {
      gate.show(waitingView(state.waitingFor));
    } else {
      gate.hide();
    }
    if (page.overlay) {
      if (state.phase === "loading") page.overlay.status("กำลังตรวจคำบรรยายของบทนี้ ...");
      else if (state.phase === "unavailable") {
        page.overlay.status(SKIP_TEXT[state.reason] || "แปลบทนี้ไม่ได้", state.reason === "native-thai" ? "ok" : "error");
      } else if (state.phase === "error") page.overlay.status(state.message, "error");
      else if (state.phase === "playing") {
        if (state.notice) page.overlay.status(state.notice, "error");
        else if (!page.announcedReady) {
          page.announcedReady = true;
          page.overlay.status(
            state.translating ? "เริ่มดูได้เลย ส่วนที่เหลือกำลังแปลอยู่เบื้องหลัง" : "พร้อมแล้ว ซับไทยครบทั้งบท",
            "ok"
          );
        }
      }
      page.overlay.hideNative(state.phase === "playing" && settings.subtitles !== "off");
    }
    if (page.menu) page.menu.render();
  }

  function drawCaption() {
    if (!page.session || !page.overlay || page.state.phase !== "playing") return;
    const settings = store.get();
    page.overlay.caption(page.session.captionAt(page.video.currentTime), settings);
  }

  // ------------------------------------------------------------ lifecycle

  function teardown() {
    pagesState.generation += 1;
    if (page.session) page.session.dispose();
    page.session = null;
    if (page.video) page.video.removeEventListener("timeupdate", drawCaption);
    if (page.overlay) page.overlay.dispose();
    if (page.menu) page.menu.dispose();
    page.overlay = null;
    page.menu = null;
    page.video = null;
    page.state = { phase: "idle" };
    page.announcedReady = false;
    gate.hide();
    if (pages) {
      pages.cleanupArticle();
      pages.cleanupQuiz();
      pages.cleanupAssignment();
    }
  }

  async function startVideo(described, generation) {
    const video = await waitForVideo(90000, () => generation === page.generation);
    if (generation !== page.generation) return;
    if (!video) {
      log("ไม่พบวิดีโอในหน้านี้");
      return;
    }
    page.video = video;
    page.overlay = UDTH.overlay.createOverlay({ site, video, isMenuOpen: () => Boolean(page.menu && page.menu.isOpen()) });
    page.menu = UDTH.menu.createMenu({
      site,
      video,
      store,
      engines: () => engines,
      refreshEngines,
      sourceLang: () => (page.session ? page.session.sourceLang : ""),
      serverIssue: () => serverIssue,
      onRetranslate: retranslate,
      onTranslateSection: pages && site.supportsSection ? () => pages.translateSection() : null,
      onToggle: () => page.overlay && page.overlay.place(),
    });
    page.overlay.ensure();
    page.menu.ensure();
    video.addEventListener("timeupdate", drawCaption);

    await refreshEngines();
    if (generation !== page.generation) return;
    page.session = UDTH.session.createSession({
      site: { title: () => site.title(), cacheScope: () => site.cacheScope(), cacheId: () => site.cacheId(),
        transcript: () => site.videoCues(described.payload) },
      video,
      api,
      settings: store,
      makeVoice,
      onState: onSessionState,
      takeForce: () => takeForceFlag(site.cacheId()),
      log,
    });
    await page.session.start();
  }

  async function startPage() {
    teardown();
    const generation = (page.generation += 1);
    pagesState.generation = generation;
    const described = await site.describe();
    if (generation !== page.generation || !described) return;
    if (described.kind === "video") return startVideo(described, generation);
    if (!pages) return;
    if (described.kind === "quiz") return pages.startQuiz(described.payload);
    if (described.kind === "assignment") return pages.startAssignment(described.payload);
    if (described.kind === "article") return pages.startArticle(described.payload);
  }

  // Both sites change lecture without a page load, and re-render their player
  // on their own schedule, taking our nodes with them. One poll handles both.
  function watchPages() {
    let failures = 0;
    let attemptedKey = null;
    const tick = async () => {
      if (page.video && page.video.isConnected) {
        if (page.overlay) page.overlay.ensure();
        if (page.menu) page.menu.ensure();
      }
      const key = site.pageKey() || location.pathname;
      if (key === page.key) return;
      if (key !== attemptedKey) {
        attemptedKey = key;
        failures = 0;
      }
      page.key = key;
      log("เริ่มบทเรียน", key);
      try {
        await startPage();
      } catch (error) {
        if (error instanceof UDTH.api.Stale) return;
        failures += 1;
        log("ผิดพลาด", error);
        const message = String((error && error.message) || error);
        // Back off, and stop after a few tries: a failure that repeats (a dead
        // server, say) must not flash an error forever.
        if (failures <= MAX_RETRIES) {
          const delay = 4000 * failures;
          if (page.overlay) page.overlay.status(`${message} ลองใหม่ใน ${delay / 1000} วินาที`, "error");
          setTimeout(() => {
            if (page.key === key) page.key = null;
          }, delay);
        } else if (page.overlay) {
          page.overlay.status(`${message} หยุดลองแล้ว กด F5 เพื่อเริ่มใหม่`, "error");
        }
      }
    };
    tick();
    setInterval(tick, 1500);
  }

  // ------------------------------------------------------------- messages

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "getState") {
      sendResponse({ ...page.state, sourceLang: page.session ? page.session.sourceLang : "", supportsSection: site.supportsSection });
      return false;
    }
    if (message.type === "translateSection") {
      // Answer now and keep working: gathering a section takes tens of
      // seconds and the popup usually closes long before then.
      if (!pages || !site.supportsSection) {
        sendResponse({ ok: false, error: "แปลล่วงหน้าทั้ง Section ใช้ได้เฉพาะบน Udemy" });
        return false;
      }
      if (pagesState.batch.preparing) {
        sendResponse({ ok: false, error: "กำลังเตรียมคิวอยู่แล้ว" });
        return false;
      }
      pages.translateSection().catch((err) => log("แปลทั้ง Section ล้มเหลว", err));
      sendResponse({ ok: true, started: true });
      return false;
    }
    return false;
  });

  store.load().then(() => {
    store.subscribe(() => {
      if (page.menu) page.menu.render();
      if (page.overlay && page.state.phase === "playing") {
        page.overlay.hideNative(store.get().subtitles !== "off");
        drawCaption();
      }
    });
    watchPages();
  });
})();
