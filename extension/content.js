// Runs on Udemy lecture pages.
//
// Where the English text comes from — verified against the live site:
// Udemy does NOT expose captions as HTML5 TextTracks (video.textTracks is
// empty even while subtitles are visibly playing); it fetches WebVTT files and
// renders them itself. It also clears the resource-timing buffer, so scraping
// the URL after the fact is unreliable.
//
// So we ask Udemy's own API for the lecture's caption list, which is
// deterministic and needs no interception:
//   /api-2.0/courses/<slug>/                        -> courseId
//   /api-2.0/users/me/subscribed-courses/<courseId>/lectures/<lectureId>/
//       ?fields[lecture]=asset&fields[asset]=captions
//       &fields[caption]=locale_id,title,url,source -> caption list + URLs
//
// If a Thai caption already exists we stay out of the way — Udemy's own track
// is better than anything we would produce. We only translate when it doesn't.

(() => {
  "use strict";

  const state = {
    lectureKey: null,
    cues: [],
    activeIndex: -1,
    status: "idle",
    enabled: true,
    dualMode: true,
    overlay: null,
    line: null,
    video: null,
    hasNativeThai: false,
    // Quiz mode: english text (normalised) -> thai, plus the DOM watcher that
    // injects it as Udemy renders one question at a time.
    quizMap: null,
    quizObserver: null,
  };

  const log = (...args) => console.log("[udth]", ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Reloading the extension while a Udemy tab is open orphans the content
  // script already injected in that tab: it keeps running but can no longer
  // reach the service worker. Name that case instead of leaving the user to
  // guess, because the fix (reload the page) is not obvious.
  function describeSendError(err) {
    const message = String((err && err.message) || err || "");
    if (/context invalidated|receiving end does not exist/i.test(message)) {
      return "ส่วนขยายเพิ่งถูกอัปเดต — กด F5 รีเฟรชหน้านี้หนึ่งครั้ง";
    }
    return "ติดต่อส่วนขยายไม่ได้ ลองรีเฟรชหน้า";
  }

  // ---------------------------------------------------------------- overlay

  function ensureOverlay(video) {
    if (state.overlay && state.overlay.isConnected) return;

    const container = video.parentElement || document.body;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }

    const overlay = document.createElement("div");
    overlay.className = "udth-overlay";
    const line = document.createElement("div");
    line.className = "udth-line";
    overlay.appendChild(line);
    container.appendChild(overlay);

    state.overlay = overlay;
    state.line = line;
  }

  function renderStatus(text, kind = "info") {
    if (!state.line) return;
    state.line.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = `udth-status udth-${kind}`;
    badge.textContent = text;
    state.line.appendChild(badge);
  }

  function clearLine() {
    if (state.line) state.line.innerHTML = "";
  }

  // Suppress Udemy's own caption layer only while we are actually showing
  // Thai — measured on a live lecture, the two overlap by ~40-60px otherwise.
  function syncNativeCaptions() {
    const hide = state.enabled && state.status === "ready" && state.cues.length > 0;
    document.documentElement.classList.toggle("udth-hide-native", hide);
  }

  function renderCue(cue) {
    if (!state.line) return;
    state.line.innerHTML = "";
    if (!cue) return;

    if (state.dualMode && cue.en) {
      const en = document.createElement("div");
      en.className = "udth-en";
      en.textContent = cue.en;
      state.line.appendChild(en);
    }
    const th = document.createElement("div");
    th.className = "udth-th";
    th.textContent = cue.th || cue.en || "";
    state.line.appendChild(th);
  }

  // ------------------------------------------------------------------ video

  function findVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    return videos.find((v) => v.duration > 1) || videos[0] || null;
  }

  // The player mounts well after document_idle — on a real lecture page it took
  // ~14s. Poll rather than guess a delay; giving up after one miss was what
  // made the overlay never appear at all.
  async function waitForVideo(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    while (Date.now() < deadline) {
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

  // -------------------------------------------------------------- Udemy API

  function lectureId() {
    return (location.pathname.match(/\/learn\/lecture\/(\d+)/) || [])[1] || null;
  }

  function courseSlug() {
    return (location.pathname.match(/\/course\/([^/]+)/) || [])[1] || null;
  }

  async function getJson(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Udemy API ตอบ ${response.status}`);
    return response.json();
  }

  // One call describes the whole lecture: is it a video or an article, which
  // captions exist, and (for articles) the HTML body.
  async function fetchLectureAsset() {
    const slug = courseSlug();
    const lecture = lectureId();
    if (!slug || !lecture) throw new Error("อ่านรหัสบทเรียนจาก URL ไม่ได้");

    const course = await getJson(`/api-2.0/courses/${slug}/?fields[course]=id`);
    const courseId = course && course.id;
    if (!courseId) throw new Error("หา course id ไม่เจอ");

    const data = await getJson(
      `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${lecture}/` +
        `?fields[lecture]=asset,title&fields[asset]=asset_type,captions,body` +
        `&fields[caption]=locale_id,title,url,source`
    );
    const asset = (data && data.asset) || {};
    return {
      courseId,
      type: asset.asset_type || "",
      captions: asset.captions || [],
      body: asset.body || "",
    };
  }

  function pickCaption(captions, prefix) {
    const matches = captions.filter((c) =>
      new RegExp(`^${prefix}`, "i").test(c.locale_id || "")
    );
    if (!matches.length) return null;
    // A human-made caption beats an auto-generated one.
    return matches.find((c) => c.source === "manual") || matches[0];
  }

  // ------------------------------------------------------------- VTT parsing

  function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
    const timing =
      /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

    for (const block of blocks) {
      const match = block.match(timing);
      if (!match) continue;
      const start = toSeconds(match[1], match[2], match[3], match[4]);
      const end = toSeconds(match[5], match[6], match[7], match[8]);

      const body = block
        .slice(block.indexOf(match[0]) + match[0].length)
        .split("\n")
        .slice(1)
        .join(" ")
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (body) cues.push({ start, end, text: body });
    }
    return cues;
  }

  function toSeconds(hours, minutes, seconds, fraction) {
    const h = hours ? parseInt(hours, 10) : 0;
    const frac = parseInt(fraction, 10) / Math.pow(10, String(fraction).length);
    return h * 3600 + parseInt(minutes, 10) * 60 + parseInt(seconds, 10) + frac;
  }

  // --------------------------------------------------------------- sync loop

  function findCueAt(time) {
    const cues = state.cues;
    if (!cues.length) return -1;

    const current = cues[state.activeIndex];
    if (current && time >= current.start && time < current.end) return state.activeIndex;

    for (let i = 0; i < cues.length; i += 1) {
      if (time >= cues[i].start && time < cues[i].end) return i;
    }
    return -1;
  }

  function onTimeUpdate() {
    if (!state.enabled || state.status !== "ready" || !state.video) return;
    const index = findCueAt(state.video.currentTime);
    if (index === state.activeIndex) return;
    state.activeIndex = index;
    renderCue(index >= 0 ? state.cues[index] : null);
  }

  // ------------------------------------------------------------ orchestration

  function lessonTitle() {
    const heading = document.querySelector(
      '[class*="curriculum-item-view--title"], [data-purpose="lecture-title"], h1'
    );
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    return text || document.title.replace(/\s*\|\s*Udemy.*$/i, "").trim() || "บทเรียน";
  }

  // Ask what kind of lecture this is before touching the player — article
  // lectures have no <video>, so waiting for one would just stall for 90s.
  // A leftover panel from the previous lecture would otherwise sit above the
  // new one, showing the wrong translation.
  function cleanupArticle() {
    const panel = document.querySelector(".udth-doc");
    if (panel) panel.remove();
    document
      .querySelectorAll('[class*="article-asset--container"],[class*="article-asset"]')
      .forEach((el) => {
        if (el.style.display === "none") el.style.display = "";
      });
  }

  async function start() {
    cleanupArticle();
    cleanupQuiz();

    // Quiz pages carry no lecture id, so they must be detected first.
    const quiz = quizId();
    if (quiz) return startQuiz(quiz);

    const asset = await fetchLectureAsset();
    log("ชนิดบทเรียน", asset.type || "(ไม่ระบุ)");

    if (asset.type === "Article") return startArticle(asset);
    return startVideo(asset);
  }

  async function startVideo(asset) {
    const video = await waitForVideo();
    if (!video) {
      log("ไม่พบวิดีโอในหน้านี้");
      return;
    }
    log("พบวิดีโอ", { duration: video.duration });

    state.video = video;
    state.cues = [];
    state.activeIndex = -1;
    state.hasNativeThai = false;
    syncNativeCaptions(); // a new lecture starts with Udemy's captions visible
    ensureOverlay(video);

    video.removeEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("timeupdate", onTimeUpdate);

    state.status = "loading";
    renderStatus("กำลังตรวจคำบรรยายของบทเรียนนี้ ...");

    const captions = asset.captions || [];
    log("พบคำบรรยาย", captions.length, "ภาษา");

    // Only a human-made Thai track beats what we produce. Udemy's "auto" Thai
    // is machine translation stacked on machine transcription — the errors
    // compound, so we translate it ourselves instead.
    const thai = pickCaption(captions, "th");
    if (thai && thai.source === "manual") {
      state.hasNativeThai = true;
      state.status = "native";
      renderStatus(
        "บทนี้มีซับไทยที่คนแปลไว้แล้ว — กด CC เลือกไทย จะดีกว่าให้ AI แปล",
        "ok"
      );
      setTimeout(() => {
        if (state.status === "native") clearLine();
      }, 8000);
      return;
    }
    const replacingAutoThai = !!thai;
    if (replacingAutoThai) {
      log("มีซับไทยแบบอัตโนมัติของ Udemy — จะแปลใหม่ด้วย AI แทน");
    }

    const english = pickCaption(captions, "en");
    if (!english || !english.url) {
      state.status = "error";
      renderStatus("บทนี้ไม่มีคำบรรยายอังกฤษให้แปล", "error");
      return;
    }

    renderStatus("กำลังโหลดคำบรรยายอังกฤษ ...");
    const vtt = await fetch(english.url).then((r) => (r.ok ? r.text() : null));
    if (!vtt) {
      state.status = "error";
      renderStatus("โหลดไฟล์คำบรรยายไม่สำเร็จ", "error");
      return;
    }

    const cues = parseVtt(vtt);
    if (!cues.length) {
      state.status = "error";
      renderStatus("อ่านไฟล์คำบรรยายไม่ได้", "error");
      return;
    }

    // "แปลบทเรียนนี้ใหม่" reloads the page, so the request survives as a flag
    // in storage rather than in memory.
    let force = false;
    try {
      const stored = await chrome.storage.local.get("forceLecture");
      if (stored.forceLecture && stored.forceLecture === lectureId()) {
        force = true;
        await chrome.storage.local.remove("forceLecture");
      }
    } catch {
      /* storage unavailable — fall back to using the cache */
    }

    state.status = "translating";
    renderStatus(
      force
        ? `กำลังแปล ${cues.length} บรรทัดใหม่ (ไม่ใช้ของเดิม) ...`
        : `กำลังแปล ${cues.length} บรรทัดเป็นไทย ... (ครั้งแรกใช้เวลาสักครู่)`
    );

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "translate",
        payload: {
          course: courseSlug(),
          lecture: lectureId(), // stable cache identity, unlike the title
          title: lessonTitle(),
          cues,
          force,
        },
      });
    } catch (err) {
      state.status = "error";
      renderStatus(describeSendError(err), "error");
      return;
    }

    if (!response || !response.ok) {
      state.status = "error";
      const detail = (response && response.error) || "ไม่ทราบสาเหตุ";
      renderStatus(
        /Failed to fetch|NetworkError/i.test(detail)
          ? "ยังไม่ได้เปิดเซิร์ฟเวอร์แปล — ดับเบิลคลิก start-server.cmd"
          : `แปลไม่สำเร็จ: ${detail}`,
        "error"
      );
      return;
    }

    state.cues = response.cues || [];
    state.status = "ready";
    state.activeIndex = -1;
    syncNativeCaptions();
    renderStatus(
      replacingAutoThai
        ? `พร้อมแล้ว — ซับไทย ${state.cues.length} บรรทัด (แปลใหม่แทนซับอัตโนมัติของ Udemy)`
        : `พร้อมแล้ว — ซับไทย ${state.cues.length} บรรทัด`,
      "ok"
    );
    setTimeout(() => {
      if (state.status === "ready") onTimeUpdate();
    }, 1500);
  }

  // ---------------------------------------------------------------- quiz mode

  function quizId() {
    return (location.pathname.match(/\/learn\/quiz\/(\d+)/) || [])[1] || null;
  }

  // Normalising makes the lookup survive Udemy re-ordering answers or
  // re-wrapping whitespace between renders.
  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  async function fetchAssessments(id) {
    const data = await getJson(
      `/api-2.0/quizzes/${id}/assessments/?page_size=200` +
        `&fields[assessment]=id,assessment_type,prompt`
    );
    return (data && data.results) || [];
  }

  // Pull every translatable string out of the quiz: the question, each answer,
  // and the explanation Udemy shows after you answer.
  function collectQuizStrings(assessments) {
    const seen = new Set();
    const strings = [];

    const add = (raw) => {
      const text = stripHtml(raw);
      const key = normalizeText(text);
      if (!text || seen.has(key) || text.length < 2) return;
      seen.add(key);
      strings.push(text);
    };

    for (const item of assessments) {
      const prompt = item.prompt || {};
      add(prompt.question);
      const answers = Array.isArray(prompt.answers) ? prompt.answers : [];
      answers.forEach(add);
      const feedbacks = Array.isArray(prompt.feedbacks) ? prompt.feedbacks : [];
      feedbacks.forEach(add);
    }
    return strings;
  }

  function stripHtml(value) {
    if (!value) return "";
    const holder = document.createElement("div");
    holder.innerHTML = value;
    return (holder.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function startQuiz(id) {
    const assessments = await fetchAssessments(id);
    if (!assessments.length) {
      log("แบบทดสอบนี้ไม่มีข้อคำถาม");
      return;
    }

    const strings = collectQuizStrings(assessments);
    log("แบบทดสอบ", assessments.length, "ข้อ /", strings.length, "ข้อความ");

    const banner = ensureQuizBanner();
    setQuizBanner(banner, `กำลังแปลแบบทดสอบ ${assessments.length} ข้อเป็นไทย ...`);
    state.status = "translating";

    let force = false;
    try {
      const stored = await chrome.storage.local.get("forceLecture");
      if (stored.forceLecture && stored.forceLecture === id) {
        force = true;
        await chrome.storage.local.remove("forceLecture");
      }
    } catch {
      /* storage unavailable — fall back to using the cache */
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "translate",
        payload: {
          course: courseSlug(),
          lecture: `quiz-${id}`, // stable cache identity, unlike the title
          title: `แบบทดสอบ ${id}`,
          cues: strings.map((text, n) => ({ start: n, end: n + 1, text })),
          mode: "doc",
          force,
        },
      });
    } catch (err) {
      state.status = "error";
      setQuizBanner(banner, describeSendError(err), "error");
      return;
    }

    if (!response || !response.ok) {
      state.status = "error";
      const detail = (response && response.error) || "ไม่ทราบสาเหตุ";
      setQuizBanner(
        banner,
        /Failed to fetch|NetworkError/i.test(detail)
          ? "ยังไม่ได้เปิดเซิร์ฟเวอร์แปล — ดับเบิลคลิก start-server.cmd"
          : `แปลไม่สำเร็จ: ${detail}`,
        "error"
      );
      return;
    }

    state.quizMap = new Map();
    (response.cues || []).forEach((cue, n) => {
      if (cue && cue.th && strings[n]) {
        state.quizMap.set(normalizeText(strings[n]), cue.th);
      }
    });

    state.status = "ready";
    setQuizBanner(
      banner,
      `แปลแล้ว ${state.quizMap.size} ข้อความ — คำแปลไทยจะขึ้นใต้ข้อความอังกฤษ`,
      "ok"
    );
    watchQuizDom();
  }

  // Udemy renders one question at a time, so translations are injected as the
  // DOM changes rather than all at once.
  const QUIZ_TEXT_SELECTOR =
    '[class*="mc-quiz-question--question-prompt"],' +
    '[class*="mc-quiz-answer--answer-body"],' +
    '[class*="feedback"] p';

  function injectQuizTranslations() {
    if (!state.quizMap || !state.enabled) return;

    document.querySelectorAll(QUIZ_TEXT_SELECTOR).forEach((el) => {
      if (el.dataset.udthDone === "1") return;

      const thai = state.quizMap.get(normalizeText(el.textContent));
      if (!thai) return;

      const line = document.createElement("div");
      line.className = "udth-quiz-th";
      line.textContent = thai;
      el.appendChild(line);
      el.dataset.udthDone = "1";
    });
  }

  function watchQuizDom() {
    injectQuizTranslations();
    if (state.quizObserver) state.quizObserver.disconnect();
    state.quizObserver = new MutationObserver(() => {
      // Cheap and idempotent: already-translated nodes are skipped by the flag.
      injectQuizTranslations();
    });
    state.quizObserver.observe(document.body, { childList: true, subtree: true });
  }

  function ensureQuizBanner() {
    let banner = document.querySelector(".udth-quiz-banner");
    if (banner) return banner;

    banner = document.createElement("div");
    banner.className = "udth-quiz-banner";
    const host =
      document.querySelector('[class*="quiz-page-content"]') ||
      document.querySelector('[class*="quiz-view--container"]') ||
      document.body;
    host.insertBefore(banner, host.firstChild);
    return banner;
  }

  function setQuizBanner(banner, text, kind = "info") {
    banner.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = `udth-status udth-${kind}`;
    badge.textContent = text;
    banner.appendChild(badge);
  }

  function cleanupQuiz() {
    if (state.quizObserver) {
      state.quizObserver.disconnect();
      state.quizObserver = null;
    }
    state.quizMap = null;
    document.querySelectorAll(".udth-quiz-th").forEach((el) => el.remove());
    document
      .querySelectorAll('[data-udth-done="1"]')
      .forEach((el) => delete el.dataset.udthDone);
    const banner = document.querySelector(".udth-quiz-banner");
    if (banner) banner.remove();
  }

  // ------------------------------------------------------------- article mode

  // Leaf-level block elements only: a <p> nested in an <li> would otherwise be
  // collected twice and translated twice.
  const BLOCK_SELECTOR =
    "p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th,dd,dt,figcaption";

  function collectBlocks(root) {
    return Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter(
      (el) => !el.querySelector(BLOCK_SELECTOR) && (el.textContent || "").trim()
    );
  }

  function isCodeBlock(el) {
    return (
      el.tagName === "PRE" ||
      el.tagName === "CODE" ||
      !!el.closest("pre") ||
      // A block that is nothing but a <code> element is code too.
      (el.children.length === 1 && el.children[0].tagName === "CODE")
    );
  }

  async function waitForArticleContainer(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const el = document.querySelector(
        '[class*="article-asset--container"],[class*="article-asset"]'
      );
      if (el) return el;
      await sleep(600);
    }
    return null;
  }

  async function startArticle(asset) {
    const container = await waitForArticleContainer();
    if (!container) {
      log("ไม่พบกล่องบทความในหน้านี้");
      return;
    }
    if (!asset.body) {
      log("บทความนี้ไม่มีเนื้อหาให้แปล");
      return;
    }

    // Work on a detached copy of the HTML Udemy gave us, not the live page.
    const holder = document.createElement("div");
    holder.innerHTML = asset.body;

    const blocks = collectBlocks(holder);
    const translatable = blocks
      .map((el, i) => ({ el, i }))
      .filter(({ el }) => !isCodeBlock(el));

    if (!translatable.length) {
      log("บทความนี้มีแต่โค้ด ไม่มีข้อความให้แปล");
      return;
    }

    state.status = "translating";
    const panel = ensureDocPanel(container);
    setDocStatus(panel, `กำลังแปลเอกสาร ${translatable.length} ย่อหน้าเป็นไทย ...`);

    let force = false;
    try {
      const stored = await chrome.storage.local.get("forceLecture");
      if (stored.forceLecture && stored.forceLecture === lectureId()) {
        force = true;
        await chrome.storage.local.remove("forceLecture");
      }
    } catch {
      /* storage unavailable — fall back to using the cache */
    }

    // Reuse the subtitle pipeline: same numbering contract, doc rule set.
    const cues = translatable.map(({ el }, n) => ({
      start: n,
      end: n + 1,
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
    }));

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "translate",
        payload: {
          course: courseSlug(),
          lecture: lectureId(), // stable cache identity, unlike the title
          title: `${lessonTitle()} (เอกสาร)`,
          cues,
          mode: "doc",
          force,
        },
      });
    } catch (err) {
      state.status = "error";
      setDocStatus(panel, describeSendError(err), "error");
      return;
    }

    if (!response || !response.ok) {
      state.status = "error";
      const detail = (response && response.error) || "ไม่ทราบสาเหตุ";
      setDocStatus(
        panel,
        /Failed to fetch|NetworkError/i.test(detail)
          ? "ยังไม่ได้เปิดเซิร์ฟเวอร์แปล — ดับเบิลคลิก start-server.cmd"
          : `แปลไม่สำเร็จ: ${detail}`,
        "error"
      );
      return;
    }

    // Write the Thai text back into the copied DOM, so headings stay headings
    // and code blocks stay exactly as the instructor wrote them.
    const translations = response.cues || [];
    translatable.forEach(({ el }, n) => {
      const th = translations[n] && translations[n].th;
      if (th) el.textContent = th;
    });

    state.status = "ready";
    renderDocPanel(panel, holder, container, translatable.length);
    log("แปลเอกสารเสร็จ", translatable.length, "ย่อหน้า");
  }

  function ensureDocPanel(container) {
    let panel = document.querySelector(".udth-doc");
    if (panel) return panel;

    panel = document.createElement("section");
    panel.className = "udth-doc";
    panel.innerHTML =
      '<div class="udth-doc-bar">' +
      '<span class="udth-doc-title">ฉบับแปลไทย</span>' +
      '<button type="button" class="udth-doc-toggle">ดูต้นฉบับอังกฤษ</button>' +
      "</div>" +
      '<div class="udth-doc-body"></div>';
    container.parentElement.insertBefore(panel, container);
    return panel;
  }

  function setDocStatus(panel, text, kind = "info") {
    const body = panel.querySelector(".udth-doc-body");
    body.innerHTML = "";
    const badge = document.createElement("div");
    badge.className = `udth-status udth-${kind}`;
    badge.textContent = text;
    body.appendChild(badge);
  }

  function renderDocPanel(panel, holder, original, count) {
    const body = panel.querySelector(".udth-doc-body");
    body.innerHTML = "";
    body.appendChild(holder);

    panel.querySelector(".udth-doc-title").textContent = `ฉบับแปลไทย (${count} ย่อหน้า)`;

    const toggle = panel.querySelector(".udth-doc-toggle");
    original.style.display = "none"; // Thai first — that is the whole point
    toggle.onclick = () => {
      const showingOriginal = original.style.display !== "none";
      original.style.display = showingOriginal ? "none" : "";
      toggle.textContent = showingOriginal ? "ดูต้นฉบับอังกฤษ" : "ซ่อนต้นฉบับอังกฤษ";
    };
  }

  // Udemy is a single-page app: the URL changes without a reload.
  function watchForLectureChange() {
    let running = false;

    const tick = async () => {
      const key = lectureId() || quizId() || location.pathname;
      if (key === state.lectureKey || running) return;

      state.lectureKey = key;
      state.status = "idle";
      running = true;
      log("เริ่มบทเรียน", key);
      try {
        await start();
      } catch (err) {
        log("ผิดพลาด", err);
        state.status = "error";
        renderStatus(`เกิดข้อผิดพลาด: ${(err && err.message) || err}`, "error");
        state.lectureKey = null; // let the next tick retry
      } finally {
        running = false;
      }
    };

    tick();
    setInterval(tick, 1500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "progress") {
      if (state.status === "translating") {
        const suffix = message.chunks ? ` (${message.progress}/${message.chunks})` : "";
        renderStatus(`กำลังแปลเป็นไทย ...${suffix}`);
      }
      return false;
    }
    if (message.type === "getState") {
      sendResponse({
        status: state.status,
        count: state.cues.length,
        enabled: state.enabled,
        dualMode: state.dualMode,
        hasNativeThai: state.hasNativeThai,
      });
      return false;
    }
    if (message.type === "setOptions") {
      if (typeof message.enabled === "boolean") state.enabled = message.enabled;
      if (typeof message.dualMode === "boolean") state.dualMode = message.dualMode;
      if (state.overlay) state.overlay.style.display = state.enabled ? "" : "none";
      state.activeIndex = -1;
      syncNativeCaptions(); // turning our overlay off restores Udemy's captions
      onTimeUpdate();
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "retranslate") {
      state.lectureKey = null;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  chrome.storage.local
    .get(["enabled", "dualMode"])
    .then((stored) => {
      if (typeof stored.enabled === "boolean") state.enabled = stored.enabled;
      if (typeof stored.dualMode === "boolean") state.dualMode = stored.dualMode;
    })
    .catch(() => {})
    .finally(() => watchForLectureChange());
})();
