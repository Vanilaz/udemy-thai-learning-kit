// Udemy's side of the site interface (YouTube's is in sites.js).
//
// Where the English text comes from, verified against the live site: Udemy
// does NOT expose captions as HTML5 TextTracks (video.textTracks is empty even
// while subtitles are visibly playing); it fetches WebVTT files and renders
// them itself, and clears the resource-timing buffer. So the lecture's caption
// list comes from Udemy's own API, which is deterministic:
//   /api-2.0/courses/<slug>/                        -> course id and locale
//   /api-2.0/users/me/subscribed-courses/<id>/lectures/<lecture>/
//       ?fields[asset]=captions,...                 -> caption list and URLs
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});
  const getJson = UDTH.util.getJson;
  const findControlBarNear = UDTH.findControlBar;
  const log = (...args) => console.log("[udth]", ...args);

  // Leaf-level block elements only: a <p> nested in an <li> would otherwise be
  // collected twice and translated twice.
  const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th,dd,dt,figcaption";

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

  function lectureId() {
    return (location.pathname.match(/\/learn\/lecture\/(\d+)/) || [])[1] || null;
  }

  function courseSlug() {
    return (location.pathname.match(/\/course\/([^/]+)/) || [])[1] || null;
  }


  let courseIdCache = { slug: null, id: null };

  async function getCourseId() {
    const slug = courseSlug();
    if (!slug) throw new Error("อ่านรหัสคอร์สจาก URL ไม่ได้");
    if (courseIdCache.slug === slug && courseIdCache.id) return courseIdCache.id;

    // `locale` is the language the course is taught in ({"locale": "es_ES"}),
    // checked against the live API. It says which caption track is the
    // instructor's own words rather than a machine translation of them.
    const course = await getJson(`/api-2.0/courses/${slug}/?fields[course]=id,locale`);
    const id = course && course.id;
    if (!id) throw new Error("หา course id ไม่เจอ");
    const locale = (course.locale && course.locale.locale) || "";
    courseIdCache = { slug, id, locale };
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
      locale: courseIdCache.locale || "",
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


  async function videoCues(asset) {
    const captions = asset.captions || [];

    // Only a human-made Thai track beats what we produce. Udemy's "auto" Thai
    // is machine translation stacked on machine transcription — the errors
    // compound, so we translate it ourselves instead.
    const thai = pickCaption(captions, "th");
    if (thai && thai.source === "manual") return { ok: false, code: "native-thai" };

    // Translate from the language the instructor actually speaks. Udemy's
    // `source` cannot tell a transcription from a machine translation (both
    // are "auto"), but the course locale can: a track in that language is the
    // instructor's own words. English stays the fallback it always was.
    const spoken = (asset.locale || "en").split(/[_-]/)[0].toLowerCase();
    const original = pickCaption(captions, spoken);
    const english = pickCaption(captions, "en");
    const others = captions.filter((c) => c.url && !/^th/i.test(c.locale_id || ""));
    const source =
      [original, english].find((c) => c && c.url && c.source === "manual") ||
      [original, english].find((c) => c && c.url) ||
      others[0];
    if (!source) return { ok: false, code: "no-english" };

    const vtt = await fetch(source.url).then((r) => (r.ok ? r.text() : null));
    if (!vtt) return { ok: false, code: "caption-fetch-failed" };

    const cues = parseVtt(vtt);
    if (!cues.length) return { ok: false, code: "caption-parse-failed" };
    const sourceLang = (source.locale_id || "en").replace("_", "-").toUpperCase();
    if (sourceLang.slice(0, 2) !== "EN") log("ภาษาต้นฉบับของคอร์ส:", asset.locale, "→ ใช้ซับ", source.locale_id);
    return { ok: true, cues, replacingAutoThai: !!thai, sourceLang };
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


  function lessonTitle() {
    const heading = document.querySelector(
      '[class*="curriculum-item-view--title"], [data-purpose="lecture-title"], h1'
    );
    const text = heading && heading.textContent ? heading.textContent.trim() : "";
    return text || document.title.replace(/\s*\|\s*Udemy.*$/i, "").trim() || "บทเรียน";
  }

  function assignmentId() {
    return (location.pathname.match(/\/learn\/practice\/(\d+)/) || [])[1] || null;
  }

  function quizId() {
    return (location.pathname.match(/\/learn\/quiz\/(\d+)/) || [])[1] || null;
  }

  UDTH.udemy = {
    name: "udemy",
    supportsSection: true,

    pageKey: () => lectureId() || quizId() || (assignmentId() ? assignmentId() + location.pathname : null),
    cacheScope: courseSlug,
    cacheId: () =>
      lectureId() || (quizId() ? `quiz-${quizId()}` : assignmentId() ? `assignment-${assignmentId()}` : null),
    title: lessonTitle,
    playerContainer: () => null, // the overlay anchors to the video's parent

    // Udemy marks its player parts with `data-purpose`, which survives the
    // per-build class-name hashing that made every class-based guess fail.
    controlBar() {
      return (
        document.querySelector('[data-purpose="video-control-bar"]') ||
        document.querySelector('[data-purpose="video-controls"]') ||
        findControlBarNear(document.querySelector("video"))
      );
    },

    async describe() {
      // Quiz and assignment pages carry no lecture id, so they come first.
      const quiz = quizId();
      if (quiz) return { kind: "quiz", payload: quiz };
      const assignment = assignmentId();
      if (assignment) return { kind: "assignment", payload: assignment };
      const asset = await fetchLectureAsset();
      log("ชนิดบทเรียน", asset.type || "(ไม่ระบุ)");
      return { kind: asset.type === "Article" ? "article" : "video", payload: asset };
    },

    videoCues,
    articleCues,
    collectBlocks,
    isCodeBlock,
    // Used by the Udemy-only page modes (modes/udemy-pages.js).
    lectureId,
    courseSlug,
    quizId,
    assignmentId,
    getCourseId,
    fetchLectureAsset,
  };
})();
