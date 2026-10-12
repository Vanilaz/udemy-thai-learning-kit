// Udemy pages that are not videos: quizzes, assignments and articles, plus
// translating a whole section ahead of time and its progress badge.
//
// Behaviour unchanged from the single-file version; everything it needs
// from the rest of the extension arrives through `ctx` (see main.js).
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  function createUdemyPages(ctx) {
    const t = (text, vars) => UDTH.i18n.t(text, vars);
    const {
      state, log, sleep, showGate, hideGate, requestTranslation, assertCurrent,
      describeTranslateError, takeForceFlag, getJson, skipText, Stale,
    } = ctx;
    const { courseSlug, lectureId, getCourseId, fetchLectureAsset, videoCues, articleCues,
      quizId } = UDTH.udemy;
    const lessonTitle = UDTH.udemy.title;

    // A leftover article panel from the previous lecture would otherwise sit
    // above the new one, showing the wrong translation.
    function cleanupArticle() {
      const panel = document.querySelector(".udth-doc");
      if (panel) panel.remove();
      document
        .querySelectorAll('[class*="article-asset--container"],[class*="article-asset"]')
        .forEach((el) => {
          if (el.style.display === "none") el.style.display = "";
        });
    }

  // ---------------------------------------------------------------- quiz mode


  // ---------------------------------------------------------- assignment mode


  function collectAssignmentBlocks(root) {
    const blocks = [];
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walk.nextNode())) {
      const text = node.nodeValue.replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) continue;
      if (/^[\d\.]*$/.test(text)) continue;
      
      const el = node.parentElement;
      if (!el) continue;
      if (el.tagName === "CODE" || el.tagName === "PRE" || el.closest("pre")) continue;
      if (el.classList.contains("udth-assignment-th")) continue;
      if (el.closest('button') || el.closest('[class*="progress-bar"]') || el.closest('[class*="banner"]')) continue;
      
      blocks.push({ el, text });
    }
    // Deduplicate elements while remembering the text we found
    const unique = [];
    const seen = new Set();
    for (const b of blocks) {
      if (!seen.has(b.el)) {
        seen.add(b.el);
        unique.push(b);
      }
    }
    return unique;
  }

  async function startAssignment(id) {
    const generation = state.generation;
    let container = null;
    for (let i = 0; i < 40; i++) {
      // The wrapper classes change depending on whether we are on the "Instructions" tab,
      // the "Submission" tab, or the general overview. 
      // Instead of hunting for the exact inner container, we look for the outermost 
      // wrapper that holds the assignment content, then collect blocks from there.
      container = 
        document.querySelector('[data-purpose="curriculum-item-viewer-content"]') ||
        document.querySelector('[class*="app--app-content"]') ||
        document.body;
      if (container) break;
      await sleep(500);
    }
    if (!container) return;

    const blocks = collectAssignmentBlocks(container);
    if (!blocks.length) return;

    state.status = "translating";
    showGate(t("กำลังแปลคำสั่ง Assignment {count} บรรทัดเป็นไทย ...", { count: blocks.length }));

    const payload = {
      course: courseSlug(),
      lecture: `assignment-${id}`,
      title: lessonTitle(),
      cues: blocks.map((b, n) => { return { start: n, end: n + 1, text: b.text }; }),
      mode: "doc",
    };

    let translated;
    try {
      translated = await requestTranslation(
        { ...payload, force: await takeForceFlag(payload.lecture) },
        generation,
        (done, total) => {
          const suffix = total ? ` (${done}/${total})` : "";
          showGate(t("กำลังแปลคำสั่ง Assignment ...{progress}", { progress: suffix }));
        }
      );
    } catch (err) {
      if (err instanceof Stale) return;
      state.status = "error";
      showGate(describeTranslateError(err), "error");
      return;
    }

    state.quizMap = new Map();
    (translated || []).forEach((cue, n) => {
      if (cue && cue.th && payload.cues[n]) {
        state.quizMap.set(normalizeText(payload.cues[n].text), cue.th);
      }
    });

    state.status = "ready";
    hideGate();
    watchAssignmentDom(container);
  }

  function injectAssignmentTranslations(container) {
    if (!state.quizMap || !state.enabled) return;
    collectAssignmentBlocks(container).forEach((b) => {
      const el = b.el;
      if (el.nextElementSibling && el.nextElementSibling.classList.contains("udth-assignment-th")) return;
      const thai = state.quizMap.get(normalizeText(b.text));
      if (!thai) return;
      const line = document.createElement("div");
      line.className = "udth-assignment-th";
      line.textContent = thai;
      line.style.fontSize = "0.95em";
      line.style.marginTop = "2px";
      line.style.color = "#c084fc";
      line.style.opacity = "0.95";
      line.style.lineHeight = "1.6";
      // Ensure we stay block-level so we don't flow inline with the next phrase
      line.style.display = "block";
      if (el.nextSibling) el.parentNode.insertBefore(line, el.nextSibling);
      else el.parentNode.appendChild(line);
    });
  }

  function watchAssignmentDom(container) {
    injectAssignmentTranslations(container);
    if (state.assignmentObserver) state.assignmentObserver.disconnect();
    state.assignmentObserver = new MutationObserver(() => injectAssignmentTranslations(container));
    state.assignmentObserver.observe(container, { childList: true, subtree: true });
  }

  function cleanupAssignment() {
    if (state.assignmentObserver) {
      state.assignmentObserver.disconnect();
      state.assignmentObserver = null;
    }
    document.querySelectorAll(".udth-assignment-th").forEach((el) => el.remove());
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
    assertCurrent(generation);
    if (!assessments.length) {
      log("แบบทดสอบนี้ไม่มีข้อคำถาม");
      return;
    }

    const strings = collectQuizStrings(assessments);
    log("แบบทดสอบ", assessments.length, "ข้อ /", strings.length, "ข้อความ");

    const banner = ensureQuizBanner();
    setQuizBanner(banner, t("กำลังแปลแบบทดสอบ {count} ข้อเป็นไทย ...", { count: assessments.length }));
    state.status = "translating";

    const force = await takeForceFlag(id);

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
          setQuizBanner(banner, t("กำลังแปลแบบทดสอบ ...{progress}", { progress: suffix }));
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
      t("แปลแล้ว {count} ข้อความ — คำแปลไทยจะขึ้นใต้ข้อความอังกฤษ", { count: state.quizMap.size }),
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
    assertCurrent(generation);
    if (!container) {
      log("ไม่พบกล่องบทความในหน้านี้");
      return;
    }
    const built = articleCues(asset);
    if (!built.ok) {
      log(skipText(built.code) || built.code);
      return;
    }
    const { holder, blocks, cues } = built;

    state.status = "translating";
    const panel = ensureDocPanel(container);
    setDocStatus(panel, t("กำลังแปลเอกสาร {count} ย่อหน้าเป็นไทย ...", { count: blocks.length }));

    const force = await takeForceFlag(lectureId());

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
          setDocStatus(panel, t("กำลังแปลเอกสาร ...{progress}", { progress: suffix }));
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
      `<span class="udth-doc-title">${t("ฉบับแปลไทย")}</span>` +
      `<button type="button" class="udth-doc-toggle">${t("ดูต้นฉบับอังกฤษ")}</button>` +
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

    panel.querySelector(".udth-doc-title").textContent = t("ฉบับแปลไทย ({count} ย่อหน้า)", { count });

    const toggle = panel.querySelector(".udth-doc-toggle");
    original.style.display = "none"; // Thai first — that is the whole point
    toggle.onclick = () => {
      const showingOriginal = original.style.display !== "none";
      original.style.display = showingOriginal ? "none" : "";
      toggle.textContent = showingOriginal ? t("ดูต้นฉบับอังกฤษ") : t("ซ่อนต้นฉบับอังกฤษ");
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

    const data = await ctx.api.enqueue(payload);
    return { outcome: data.cached ? "cached" : "queued" };
  }

  async function translateSection() {
    if (state.batch.preparing) {
      return { ok: false, error: t("กำลังเตรียมคิวอยู่แล้ว") };
    }

    const here = lectureId() || quizId();
    if (!here) {
      return { ok: false, error: t("เปิดบทเรียนสักบทก่อน แล้วค่อยสั่งแปลทั้ง Section") };
    }

    state.batch.preparing = true;
    showBatch(t("กำลังอ่านรายการบทเรียนใน Section ..."), "");
    try {
      const courseId = await getCourseId();
      const items = await fetchCurriculum(courseId);
      const section = sectionContaining(items, here);
      if (!section) throw new Error(t("หา Section ของบทเรียนนี้ไม่เจอ"));

      const targets = section.items.filter(
        (i) =>
          i._class === "lecture" &&
          BATCH_ASSET_TYPES.includes((i.asset || {}).asset_type)
      );
      const label = `Section ${section.number} — ${section.title}`;
      log("แปลทั้ง Section", label, targets.length, "บทเรียน");

      if (!targets.length) {
        showBatch(t("Section นี้ไม่มีวิดีโอหรือบทความให้แปล"), "ok", label);
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
          t("กำลังเตรียม {done}/{total} บทเรียน", { done: n + 1, total: targets.length }),
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
          cached ? t("Section นี้แปลไว้หมดแล้ว ({count} บทเรียน)", { count: cached }) : t("ไม่มีบทเรียนที่แปลได้"),
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
      '<button type="button" class="udth-batch-close" aria-label="' + t("ปิดกล่องสถานะ") + '">&times;</button>' +
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
  // How many lectures are being translated right now. The server runs several
  // at once, so the old "is there a running job? then 1" undercounted as soon
  // as more than one was in flight. `running_count` is missing on an older
  // server, where the presence of `running` is still the best answer available.
  function runningCount(info) {
    if (typeof info.running_count === "number") return info.running_count;
    return info.running ? 1 : 0;
  }

      let info = null;
      try {
        info = await ctx.api.queue();
      } catch {
        /* worker asleep or extension reloaded — try again next tick */
      }
      if (!info) return;

      const left = (info.queued || 0) + runningCount(info);
      if (!left) {
        stopQueueWatch();
        showBatch(
          info.failed
            ? t("แปลล่วงหน้าเสร็จ — พลาด {failed} บทเรียน", { failed: info.failed })
            : t("แปลล่วงหน้าเสร็จแล้ว เปิดบทถัดไปได้เลย"),
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
        t("กำลังแปลล่วงหน้า {done}/{total} บทเรียน", { done, total }),
        "",
        now || state.batch.label,
        total ? done / total : null
      );
    };

    tick();
    state.batch.timer = setInterval(tick, QUEUE_POLL_MS);
  }



    return {
      startQuiz, startAssignment, startArticle,
      cleanupQuiz, cleanupAssignment, cleanupArticle,
      translateSection,
    };
  }

  UDTH.udemyPages = { createUdemyPages };
})();
