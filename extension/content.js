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
    // Bumped on every lecture change. Work started under an older value is
    // abandoned instead of being written into the page the user has moved to.
    generation: 0,
    // Section batch. Deliberately untouched by lecture changes: the queue lives
    // on the server and keeps running while the user watches something else.
    batch: { preparing: false, timer: null, total: 0, label: "" },
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
    if (/message channel closed|message port closed/i.test(message)) {
      return "การเชื่อมต่อกับส่วนขยายหลุด กำลังลองใหม่ ...";
    }
    return `ติดต่อส่วนขยายไม่ได้: ${message.slice(0, 80)}`;
  }

  // Every failure the user can actually act on, phrased as what to do next.
  function describeTranslateError(err) {
    const message = String((err && err.message) || err || "");
    if (/Failed to fetch|NetworkError|ECONNREFUSED/i.test(message)) {
      return "ยังไม่ได้เปิดเซิร์ฟเวอร์แปล — ดับเบิลคลิก start-server.cmd";
    }
    if (/context invalidated|receiving end does not exist|message channel closed/i.test(message)) {
      return describeSendError(err);
    }
    return `แปลไม่สำเร็จ: ${message.slice(0, 120)}`;
  }

  const POLL_INTERVAL_MS = 2000;
  const POLL_TIMEOUT_MS = 15 * 60 * 1000;

  class Stale extends Error {}

  // Ask the service worker to start a job, then wait here rather than there.
  // Each message is a single short round trip, which is all an MV3 worker can
  // reliably serve; the waiting happens in the page, which Chrome never kills.
  //
  // `generation` guards against the user moving to another lecture mid-flight:
  // when it no longer matches, the result belongs to a page that is gone.
  async function requestTranslation(payload, generation, onProgress) {
    const started = await chrome.runtime.sendMessage({ type: "startJob", payload });
    if (generation !== state.generation) throw new Stale();
    if (!started || !started.ok) {
      throw new Error((started && started.error) || "เริ่มงานแปลไม่สำเร็จ");
    }

    const job = started.data || {};
    if (job.status === "done" && job.cues) return job.cues;

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (generation !== state.generation) throw new Stale();

      const polled = await chrome.runtime.sendMessage({
        type: "jobStatus",
        jobId: job.job,
      });
      if (generation !== state.generation) throw new Stale();
      if (!polled || !polled.ok) {
        throw new Error((polled && polled.error) || "อ่านสถานะงานไม่ได้");
      }

      const info = polled.data || {};
      if (info.status === "done") return info.cues || [];
      if (info.status === "error") throw new Error(info.error || "แปลไม่สำเร็จ");
      if (onProgress) onProgress(info.progress || 0, info.chunks || 0);
    }
    throw new Error("แปลนานเกินไป ยกเลิกแล้ว");
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

  let courseIdCache = { slug: null, id: null };

  async function getCourseId() {
    const slug = courseSlug();
    if (!slug) throw new Error("อ่านรหัสคอร์สจาก URL ไม่ได้");
    if (courseIdCache.slug === slug && courseIdCache.id) return courseIdCache.id;

    const course = await getJson(`/api-2.0/courses/${slug}/?fields[course]=id`);
    const id = course && course.id;
    if (!id) throw new Error("หา course id ไม่เจอ");
    courseIdCache = { slug, id };
    return id;
  }

  // One call describes the whole lecture: is it a video or an article, which
  // captions exist, and (for articles) the HTML body.
  //
  // The id is a parameter rather than always being read from the URL, because
  // translating a section ahead of time means asking about lectures the user
  // has not opened yet.
  async function fetchLectureAsset(lecture) {
    const target = lecture || lectureId();
    if (!target) throw new Error("อ่านรหัสบทเรียนจาก URL ไม่ได้");

    const courseId = await getCourseId();
    const data = await getJson(
      `/api-2.0/users/me/subscribed-courses/${courseId}/lectures/${target}/` +
        `?fields[lecture]=asset,title&fields[asset]=asset_type,captions,body` +
        `&fields[caption]=locale_id,title,url,source`
    );
    const asset = (data && data.asset) || {};
    return {
      courseId,
      title: (data && data.title) || "",
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

  // ------------------------------------------------------- cues from an asset
  //
  // The lecture on screen and a lecture queued for later both come through
  // here. That matters: the server keys its cache on the cue list, so if the
  // two paths built cues even slightly differently, everything translated in
  // advance would miss the cache and be translated a second time.

  const SKIP_TEXT = {
    "no-english": "บทนี้ไม่มีคำบรรยายอังกฤษให้แปล",
    "caption-fetch-failed": "โหลดไฟล์คำบรรยายไม่สำเร็จ",
    "caption-parse-failed": "อ่านไฟล์คำบรรยายไม่ได้",
    "empty-article": "บทความนี้ไม่มีเนื้อหาให้แปล",
    "code-only": "บทความนี้มีแต่โค้ด ไม่มีข้อความให้แปล",
  };

  async function videoCues(asset) {
    const captions = asset.captions || [];

    // Only a human-made Thai track beats what we produce. Udemy's "auto" Thai
    // is machine translation stacked on machine transcription — the errors
    // compound, so we translate it ourselves instead.
    const thai = pickCaption(captions, "th");
    if (thai && thai.source === "manual") return { ok: false, code: "native-thai" };

    const english = pickCaption(captions, "en");
    if (!english || !english.url) return { ok: false, code: "no-english" };

    const vtt = await fetch(english.url).then((r) => (r.ok ? r.text() : null));
    if (!vtt) return { ok: false, code: "caption-fetch-failed" };

    const cues = parseVtt(vtt);
    if (!cues.length) return { ok: false, code: "caption-parse-failed" };
    return { ok: true, cues, replacingAutoThai: !!thai };
  }

  function articleCues(asset) {
    if (!asset.body) return { ok: false, code: "empty-article" };

    // Work on a detached copy of the HTML Udemy gave us, not the live page.
    const holder = document.createElement("div");
    holder.innerHTML = asset.body;

    const blocks = collectBlocks(holder).filter((el) => !isCodeBlock(el));
    if (!blocks.length) return { ok: false, code: "code-only" };

    return {
      ok: true,
      holder,
      blocks,
      cues: blocks.map((el, n) => ({
        start: n,
        end: n + 1,
        text: (el.textContent || "").replace(/\s+/g, " ").trim(),
      })),
    };
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
    // Anything still in flight from the previous lecture is now stale.
    state.generation += 1;
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
    const generation = state.generation;
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

    log("พบคำบรรยาย", (asset.captions || []).length, "ภาษา");

    const built = await videoCues(asset);
    if (!built.ok && built.code === "native-thai") {
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
    if (!built.ok) {
      state.status = "error";
      renderStatus(SKIP_TEXT[built.code] || "แปลบทนี้ไม่ได้", "error");
      return;
    }

    const cues = built.cues;
    const replacingAutoThai = built.replacingAutoThai;
    if (replacingAutoThai) {
      log("มีซับไทยแบบอัตโนมัติของ Udemy — จะแปลใหม่ด้วย AI แทน");
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

    let translated;
    try {
      translated = await requestTranslation(
        {
          course: courseSlug(),
          lecture: lectureId(), // stable cache identity, unlike the title
          title: lessonTitle(),
          cues,
          force,
        },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          renderStatus(`กำลังแปลเป็นไทย ...${suffix}`);
        }
      );
    } catch (err) {
      if (err instanceof Stale) return; // user moved on; nothing to report
      state.status = "error";
      renderStatus(describeTranslateError(err), "error");
      return;
    }

    state.cues = translated || [];
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
    const generation = state.generation;
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

    let translated;
    try {
      translated = await requestTranslation(
        {
          course: courseSlug(),
          lecture: `quiz-${id}`, // stable cache identity, unlike the title
          title: `แบบทดสอบ ${id}`,
          cues: strings.map((text, n) => ({ start: n, end: n + 1, text })),
          mode: "doc",
          force,
        },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          setQuizBanner(banner, `กำลังแปลแบบทดสอบ ...${suffix}`);
        }
      );
    } catch (err) {
      if (err instanceof Stale) return; // user moved on; nothing to report
      state.status = "error";
      setQuizBanner(banner, describeTranslateError(err), "error");
      return;
    }

    state.quizMap = new Map();
    (translated || []).forEach((cue, n) => {
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
    const generation = state.generation;
    const container = await waitForArticleContainer();
    if (!container) {
      log("ไม่พบกล่องบทความในหน้านี้");
      return;
    }
    const built = articleCues(asset);
    if (!built.ok) {
      log(SKIP_TEXT[built.code] || built.code);
      return;
    }
    const { holder, blocks, cues } = built;

    state.status = "translating";
    const panel = ensureDocPanel(container);
    setDocStatus(panel, `กำลังแปลเอกสาร ${blocks.length} ย่อหน้าเป็นไทย ...`);

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

    let translations;
    try {
      translations = await requestTranslation(
        {
          course: courseSlug(),
          lecture: lectureId(), // stable cache identity, unlike the title
          title: `${lessonTitle()} (เอกสาร)`,
          cues,
          mode: "doc",
          force,
        },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          setDocStatus(panel, `กำลังแปลเอกสาร ...${suffix}`);
        }
      );
    } catch (err) {
      if (err instanceof Stale) return; // user moved on; nothing to report
      state.status = "error";
      setDocStatus(panel, describeTranslateError(err), "error");
      return;
    }

    // Write the Thai text back into the copied DOM, so headings stay headings
    // and code blocks stay exactly as the instructor wrote them.
    translations = translations || [];
    blocks.forEach((el, n) => {
      const th = translations[n] && translations[n].th;
      if (th) el.textContent = th;
    });

    state.status = "ready";
    renderDocPanel(panel, holder, container, blocks.length);
    log("แปลเอกสารเสร็จ", blocks.length, "ย่อหน้า");
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

  // --------------------------------------------------------- section batching
  //
  // Translating only the lecture on screen means waiting at the start of every
  // single one. Queueing the whole section instead means waiting once: by the
  // time you reach lecture 3, the server has already translated it and the
  // page finds it in the cache.

  // Measured on a real course: the curriculum comes back paginated at 200 items
  // and a large course ran to 520, so reading only the first page would hide
  // most of its sections.
  const CURRICULUM_PAGE_SIZE = 200;
  const CURRICULUM_MAX_PAGES = 12;

  async function fetchCurriculum(courseId) {
    const items = [];
    for (let page = 1; page <= CURRICULUM_MAX_PAGES; page += 1) {
      const data = await getJson(
        `/api-2.0/courses/${courseId}/subscriber-curriculum-items/` +
          `?page_size=${CURRICULUM_PAGE_SIZE}&page=${page}` +
          `&fields[lecture]=id,title,object_index,asset` +
          `&fields[chapter]=id,title,object_index` +
          `&fields[quiz]=id,title,object_index,type` +
          `&fields[practice]=id,title,object_index` +
          `&fields[asset]=asset_type`
      );
      items.push(...((data && data.results) || []));
      if (!data || !data.next) break;
    }
    return items;
  }

  // The list is flat; a "chapter" entry marks where each section begins.
  function sectionContaining(items, id) {
    const sections = [];
    let current = null;
    for (const item of items) {
      if (item._class === "chapter") {
        current = { title: item.title || "Section", items: [] };
        sections.push(current);
      } else if (current) {
        current.items.push(item);
      }
    }
    const wanted = String(id);
    const index = sections.findIndex((s) =>
      s.items.some((i) => String(i.id) === wanted)
    );
    if (index < 0) return null;
    return { ...sections[index], number: index + 1, total: sections.length };
  }

  // Videos and articles only. Practice tests are a different endpoint, and one
  // of them held 250 questions — queueing that behind a section the user wants
  // to watch tonight would bury the queue.
  const BATCH_ASSET_TYPES = ["Video", "Article"];

  async function queueLecture(item) {
    const asset = await fetchLectureAsset(item.id);
    const title = item.title || asset.title || `บทเรียน ${item.id}`;

    let payload;
    if (asset.type === "Article") {
      const built = articleCues(asset);
      if (!built.ok) return { outcome: "skipped", reason: built.code };
      payload = {
        course: courseSlug(),
        lecture: String(item.id),
        title: `${title} (เอกสาร)`,
        cues: built.cues,
        mode: "doc",
      };
    } else {
      const built = await videoCues(asset);
      if (!built.ok) return { outcome: "skipped", reason: built.code };
      payload = {
        course: courseSlug(),
        lecture: String(item.id),
        title,
        cues: built.cues,
      };
    }

    const started = await chrome.runtime.sendMessage({
      type: "startJob",
      payload: { ...payload, batch: true },
    });
    if (!started || !started.ok) {
      throw new Error((started && started.error) || "ส่งงานเข้าคิวไม่สำเร็จ");
    }
    const data = started.data || {};
    return { outcome: data.cached ? "cached" : "queued" };
  }

  async function translateSection() {
    if (state.batch.preparing) {
      return { ok: false, error: "กำลังเตรียมคิวอยู่แล้ว" };
    }

    const here = lectureId() || quizId();
    if (!here) {
      return { ok: false, error: "เปิดบทเรียนสักบทก่อน แล้วค่อยสั่งแปลทั้ง Section" };
    }

    state.batch.preparing = true;
    showBatch("กำลังอ่านรายการบทเรียนใน Section ...", "");
    try {
      const courseId = await getCourseId();
      const items = await fetchCurriculum(courseId);
      const section = sectionContaining(items, here);
      if (!section) throw new Error("หา Section ของบทเรียนนี้ไม่เจอ");

      const targets = section.items.filter(
        (i) =>
          i._class === "lecture" &&
          BATCH_ASSET_TYPES.includes((i.asset || {}).asset_type)
      );
      const label = `Section ${section.number} — ${section.title}`;
      log("แปลทั้ง Section", label, targets.length, "บทเรียน");

      if (!targets.length) {
        showBatch("Section นี้ไม่มีวิดีโอหรือบทความให้แปล", "ok", label);
        setTimeout(hideBatch, 8000);
        return { ok: true, queued: 0, cached: 0, skipped: 0, section: label };
      }

      let queued = 0;
      let cached = 0;
      let skipped = 0;
      // Kept apart from `skipped`: a lecture with no English captions is a fact
      // about the course, but a refused request means something is wrong and
      // the user needs to be told what.
      let lastError = null;

      for (let n = 0; n < targets.length; n += 1) {
        showBatch(
          `กำลังเตรียม ${n + 1}/${targets.length} บทเรียน`,
          "",
          label,
          n / targets.length
        );
        try {
          const result = await queueLecture(targets[n]);
          if (result.outcome === "cached") cached += 1;
          else if (result.outcome === "queued") queued += 1;
          else {
            skipped += 1;
            log("ข้าม", targets[n].title, result.reason);
          }
        } catch (err) {
          lastError = err;
          log("ข้าม", targets[n].title, err);
        }
      }

      // Nothing got through and every attempt threw — report the cause rather
      // than claiming the section has nothing to translate.
      if (!queued && !cached && lastError) throw lastError;

      state.batch.label = label;
      state.batch.total = queued;
      log("เข้าคิวแล้ว", { queued, cached, skipped, failed: lastError ? 1 : 0 });

      if (queued) {
        startQueueWatch();
      } else {
        showBatch(
          cached ? `Section นี้แปลไว้หมดแล้ว (${cached} บทเรียน)` : "ไม่มีบทเรียนที่แปลได้",
          "ok",
          label
        );
        setTimeout(hideBatch, 8000);
      }
      return { ok: true, queued, cached, skipped, section: label };
    } catch (err) {
      const text = describeTranslateError(err);
      showBatch(text, "error");
      return { ok: false, error: text };
    } finally {
      state.batch.preparing = false;
    }
  }

  // ------------------------------------------------------------- batch badge

  function ensureBatchBadge() {
    let badge = document.querySelector(".udth-batch");
    if (badge) return badge;

    badge = document.createElement("div");
    badge.className = "udth-batch";
    // Progress is announced, not shouted: polite means a screen reader finishes
    // the sentence it is on before reading the update.
    badge.setAttribute("aria-live", "polite");
    badge.innerHTML =
      '<div class="udth-batch-head">' +
      '<span class="udth-batch-title"></span>' +
      '<button type="button" class="udth-batch-close" aria-label="ปิดกล่องสถานะ">&times;</button>' +
      "</div>" +
      '<div class="udth-batch-detail"></div>' +
      '<div class="udth-batch-track"><div class="udth-batch-fill"></div></div>';
    document.body.appendChild(badge);
    badge.querySelector(".udth-batch-close").addEventListener("click", hideBatch);
    return badge;
  }

  function showBatch(text, kind = "", detail = "", ratio = null) {
    const badge = ensureBatchBadge();
    badge.className = `udth-batch${kind ? ` udth-batch-${kind}` : ""}`;
    badge.querySelector(".udth-batch-title").textContent = text;

    const detailEl = badge.querySelector(".udth-batch-detail");
    detailEl.textContent = detail;
    detailEl.style.display = detail ? "" : "none";

    const track = badge.querySelector(".udth-batch-track");
    track.style.display = ratio === null ? "none" : "";
    if (ratio !== null) {
      const percent = Math.max(0, Math.min(1, ratio)) * 100;
      badge.querySelector(".udth-batch-fill").style.width = `${percent}%`;
    }
  }

  function hideBatch() {
    stopQueueWatch();
    const badge = document.querySelector(".udth-batch");
    if (badge) badge.remove();
  }

  const QUEUE_POLL_MS = 3000;

  function stopQueueWatch() {
    if (state.batch.timer) {
      clearInterval(state.batch.timer);
      state.batch.timer = null;
    }
  }

  // Keeps reporting after the user moves to the next lecture — the queue lives
  // on the server, so it outlives whichever page happens to be open.
  function startQueueWatch() {
    if (state.batch.timer) return;

    const tick = async () => {
      let info = null;
      try {
        const res = await chrome.runtime.sendMessage({ type: "queueStatus" });
        if (res && res.ok) info = res.data;
      } catch {
        /* worker asleep or extension reloaded — try again next tick */
      }
      if (!info) return;

      const left = (info.queued || 0) + (info.running ? 1 : 0);
      if (!left) {
        stopQueueWatch();
        showBatch(
          info.failed
            ? `แปลล่วงหน้าเสร็จ — พลาด ${info.failed} บทเรียน`
            : "แปลล่วงหน้าเสร็จแล้ว เปิดบทถัดไปได้เลย",
          info.failed ? "error" : "ok",
          state.batch.label
        );
        setTimeout(hideBatch, 10000);
        return;
      }

      const total = state.batch.total || left;
      const done = Math.max(0, total - left);
      const now = info.running ? info.running.title : "";
      showBatch(
        `กำลังแปลล่วงหน้า ${done}/${total} บทเรียน`,
        "",
        now || state.batch.label,
        total ? done / total : null
      );
    };

    tick();
    state.batch.timer = setInterval(tick, QUEUE_POLL_MS);
  }

  // Udemy is a single-page app: the URL changes without a reload.
  const MAX_RETRIES = 3;

  function watchForLectureChange() {
    let running = false;
    let failures = 0;
    // A retry clears state.lectureKey, so the next tick looks exactly like a
    // lecture change. Tracking the key separately is what keeps the retry
    // counter climbing instead of resetting to zero on every attempt — without
    // it MAX_RETRIES never bites and the loop runs forever.
    let attemptedKey = null;

    const tick = async () => {
      const key = lectureId() || quizId() || location.pathname;
      if (key === state.lectureKey || running) return;

      if (key !== attemptedKey) {
        attemptedKey = key;
        failures = 0;
      }
      state.lectureKey = key;
      state.status = "idle";
      running = true;
      log("เริ่มบทเรียน", key);
      try {
        await start();
      } catch (err) {
        failures += 1;
        log("ผิดพลาด", err);
        state.status = "error";

        // Clearing lectureKey immediately made the next tick retry 1.5s later,
        // and a failure that repeats (a dead server, say) turned into an error
        // message flashing forever. Back off, and give up after a few tries.
        if (failures <= MAX_RETRIES) {
          const delay = 4000 * failures;
          renderStatus(
            `${describeTranslateError(err)} — ลองใหม่ใน ${Math.round(delay / 1000)} วินาที`,
            "error"
          );
          setTimeout(() => {
            if (state.lectureKey === key) state.lectureKey = null;
          }, delay);
        } else {
          renderStatus(
            `${describeTranslateError(err)} — หยุดลองแล้ว กด F5 เพื่อเริ่มใหม่`,
            "error"
          );
        }
      } finally {
        running = false;
      }
    };

    tick();
    setInterval(tick, 1500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    if (message.type === "translateSection") {
      // Answer now and keep working. Gathering a section takes tens of seconds
      // and the popup usually closes long before then; holding the message
      // channel open that long is exactly what broke the old design.
      if (state.batch.preparing) {
        sendResponse({ ok: false, error: "กำลังเตรียมคิวอยู่แล้ว" });
        return false;
      }
      translateSection().catch((err) => log("แปลทั้ง Section ล้มเหลว", err));
      sendResponse({ ok: true, started: true });
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
