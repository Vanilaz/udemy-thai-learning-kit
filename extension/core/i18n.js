// The words on screen, in Thai or English.
//
// Thai is the source language: every message is written in Thai where it is
// used, wrapped in `t()`, and English comes from the table below. A message
// with no English entry shows in Thai rather than as a key, and
// tests/i18n.test.cjs fails the build when one is missing, so the table and
// the code cannot drift apart. Placeholders are `{name}`.
"use strict";
(() => {
  const UDTH = (globalThis.UDTH = globalThis.UDTH || {});

  const EN = {
    // ---- product
    "ฮองเรียน": "HongRian",
    "ไทย": "Thai",
    "ซับไทยและเสียงพากย์": "Thai subtitles and dubbing",
    "ฮองเรียน: ซับไทยและเสียงพากย์": "HongRian: Thai subtitles and dubbing",
    "ซับไทย + เสียงพากย์ · Udemy / YouTube": "Thai subtitles + dubbing · Udemy / YouTube",
    "ภาษาของหน้าจอ": "Interface language",

    // ---- settings (menu and popup)
    "ปิดเมนู": "Close menu",
    "ทำงานอัตโนมัติ": "Auto-translate",
    "เปิดอยู่ · แปลซับและบทเรียนให้อัตโนมัติ": "On · translates lectures automatically",
    "ปิดอยู่ · กดเพื่อเริ่มแปลบทเรียนนี้": "Off · press to start translating",
    "ซับบนวิดีโอ": "Subtitles",
    "ปิด": "Off",
    "ไทย + ต้นฉบับ": "Thai + original",
    "ขนาดตัวอักษร": "Text size",
    "เล็ก": "Small",
    "กลาง": "Medium",
    "ใหญ่": "Large",
    "พากย์เสียงไทย": "Thai dubbing",
    "เปิดอยู่ · {voice}": "On · {voice}",
    "ปิด · กดเพื่อฟังเสียงพากย์ไทย": "Off · press to hear the Thai dub",
    "เริ่มเล่นเมื่อไหร่": "When to start",
    "เริ่มทันที": "Instant",
    "แม่นยำ": "Accurate",
    "เล่นได้ทันที Seamless แปลและพากย์จากต้นฉบับ แล้วเปลี่ยนเป็นคำแปล AI เมื่อแปลเสร็จ":
      "Plays right away: Seamless translates and dubs from the original, then switches to the AI translation as it arrives",
    "รอ AI แปลก่อนราว 1 นาที ซับและเสียงตรงกันทุกคำ แม่นที่สุด":
      "Waits about a minute for the AI translation; subtitles and voice match word for word, most accurate",
    "ตั้งค่าเสียงพากย์": "Dub settings",
    "เครื่องมือเสียง": "Voice engine",
    "เสียง": "Voice",
    "เลือกอัตโนมัติ": "Automatic",
    "ความดังเสียงพากย์": "Dub volume",
    "ความดังเสียงผู้สอน": "Instructor volume",
    "เร่งเสียงพากย์ได้สูงสุด": "Fastest dub speed",
    "แปลใหม่": "Retranslate",
    "แปลทั้ง Section ล่วงหน้า": "Translate section",
    "Windows (เสียงในเบราว์เซอร์)": "Windows (browser voice)",
    "{engine} (ยังไม่พร้อม)": "{engine} (not ready)",
    "เซิร์ฟเวอร์ไม่มีเครื่องมือเสียงนี้": "The server does not have this voice engine",
    "กำลังเตรียมคิว ...": "Preparing the queue ...",
    "ส่งเข้าคิวแล้ว ดูความคืบหน้าที่มุมซ้ายล่าง": "Queued. Progress is shown at the bottom left",
    "เชื่อมต่อ A100 แล้ว": "A100 connected",
    "โหมดเครื่องตัวเอง": "Local mode",
    "คลาวด์ A100": "A100 Cloud",
    "การ์ดจอ": "Local GPU",
    "คลาวด์ฟรี": "Free Cloud",
    "ในเบราว์เซอร์": "Browser",

    // ---- popup only
    "กำลังตรวจสอบ ...": "Checking ...",
    "การแสดงผล": "Display",
    "แปลซับและบทเรียนเมื่อเปิดหน้า": "Translate subtitles and lectures when opened",
    "ส่วนขยายปิดอยู่ กดสวิตช์ทำงานอัตโนมัติเพื่อเริ่มแปล":
      "The extension is paused. Turn on Auto-translate to start",
    "ซับไทย": "Thai subtitles",
    "แสดงคำแปลทับบนวิดีโอ":"Show the translation over the video",
    "ต้นฉบับกำกับ": "Show the original",
    "ต้นฉบับบรรทัดเล็กใต้ซับไทย": "The original in a small line under the Thai",
    "อ่านซับไทยออกเสียงตามจังหวะ": "Reads the Thai subtitles aloud, in time",
    "แปลทั้ง Section นี้ล่วงหน้า": "Translate this whole section ahead",
    "แปลบทเรียนนี้ใหม่": "Translate this lecture again",
    "ต้องเปิด <code>start-server.cmd</code> ค้างไว้ระหว่างเรียน":
      "Keep <code>start-server.cmd</code> open while you study",
    "เซิร์ฟเวอร์พร้อมทำงาน": "Server is ready",
    "เปิดวิดีโอใน Udemy หรือ YouTube ได้เลย ครั้งแรกของแต่ละบทจะใช้เวลาแปลสักครู่":
      "Open a video on Udemy or YouTube. The first time for each lecture takes a moment to translate",
    "ดับเบิลคลิก <code>start-server.cmd</code> ในโฟลเดอร์โปรเจกต์ แล้วเปิดหน้านี้ใหม่":
      "Double-click <code>start-server.cmd</code> in the project folder, then open this again",
    "หน้าวิดีโอนี้ยังไม่มีส่วนขยายทำงาน กด F5 รีเฟรชหน้าวิดีโอหนึ่งครั้ง":
      "The extension is not running on this video page yet. Press F5 once to refresh it",
    "{lang} → ไทย": "{lang} → Thai",
    "กำลังเล่น {lang} · ส่วนที่เหลือกำลังแปล": "Playing {lang} · the rest is being translated",
    "กำลังเล่น {lang} · แปลครบแล้ว": "Playing {lang} · fully translated",
    "กำลังเตรียมบทนี้ {lang}": "Preparing this lecture {lang}",
    "แปลล่วงหน้าเสร็จ พลาด {failed} บทเรียน": "Done translating ahead; {failed} lectures failed",
    "แปลล่วงหน้าเสร็จแล้ว": "Done translating ahead",
    "กำลังแปลล่วงหน้า {done}/{total} บทเรียน": "Translating ahead {done}/{total} lectures",
    "ส่งเข้าคิวแล้ว": "Queued",
    "ดูความคืบหน้าได้ที่มุมซ้ายล่างของหน้า Udemy เปลี่ยนบทเรียนระหว่างนี้ได้":
      "Progress is shown at the bottom left of the Udemy page. You can change lectures meanwhile",
    "สั่งแปลทั้ง Section ไม่สำเร็จ": "Could not queue the section",
    "หน้านี้ยังไม่พร้อม กด F5 รีเฟรชหน้า Udemy หนึ่งครั้ง": "This page is not ready. Press F5 once to refresh Udemy",

    // ---- server and connection
    "เซิร์ฟเวอร์เป็นเวอร์ชัน {server} แต่ส่วนขยายเป็น {mine} ปิดแล้วเปิด start-server.cmd ใหม่":
      "The server is version {server} but the extension is {mine}. Close and reopen start-server.cmd",
    "เซิร์ฟเวอร์เป็นเวอร์ชันเก่า ปิดแล้วเปิด start-server.cmd ใหม่":
      "The server is an older version. Close and reopen start-server.cmd",
    "ส่วนขยายเพิ่งถูกอัปเดต กด F5 รีเฟรชหน้านี้หนึ่งครั้ง": "The extension was just updated. Press F5 once to refresh this page",
    "การเชื่อมต่อกับส่วนขยายหลุด กำลังลองใหม่": "Lost the connection to the extension. Retrying",
    "ติดต่อส่วนขยายไม่ได้: {detail}": "Cannot reach the extension: {detail}",
    "ส่วนขยายไม่ตอบ กด F5 รีเฟรชหน้านี้": "The extension is not answering. Press F5 to refresh this page",
    "ยังไม่ได้เปิดเซิร์ฟเวอร์ ดับเบิลคลิก start-server.cmd": "The server is not running. Double-click start-server.cmd",
    "เซิร์ฟเวอร์ตอบ {status}": "The server answered {status}",
    "แปลไม่สำเร็จ: {reason}": "Translation failed: {reason}",
    "ไม่ทราบสาเหตุ": "unknown reason",
    "งานแปลนี้ถูกยกเลิก": "This translation was cancelled",
    "แปลนานเกินไป ยกเลิกแล้ว": "Translation took too long and was stopped",
    "เซิร์ฟเวอร์ไม่ตอบภายใน {seconds} วินาที": "The server did not answer within {seconds} seconds",
    "อ่านไฟล์เสียงไม่ได้ (HTTP {status})": "Could not read the audio file (HTTP {status})",
    "ไม่รู้ว่าอยู่แท็บไหน": "Could not tell which tab this is",

    // ---- lecture states
    "บทนี้มีซับไทยที่คนแปลไว้แล้ว กด CC แล้วเลือกภาษาไทย จะดีกว่าให้ AI แปล":
      "This lecture already has human Thai captions. Press CC and choose Thai; they beat an AI translation",
    "บทนี้ไม่มีคำบรรยายต้นฉบับให้แปล": "This lecture has no original captions to translate",
    "วิดีโอนี้ไม่มีคำบรรยายเลย จึงแปลไม่ได้": "This video has no captions, so it cannot be translated",
    "YouTube ไม่ยอมส่งไฟล์คำบรรยายมา ลองเปิด CC บนวิดีโอสักครั้งแล้วกด F5":
      "YouTube would not send the captions. Turn CC on once, then press F5",
    "ขอ token จาก YouTube ไม่ได้ เล่นวิดีโอสักครู่ กดปุ่ม CC หนึ่งครั้ง แล้วกด F5":
      "Could not get a token from YouTube. Play the video briefly, press CC once, then press F5",
    "โหลดไฟล์คำบรรยายไม่สำเร็จ": "Could not load the captions",
    "อ่านไฟล์คำบรรยายไม่ได้": "Could not read the captions",
    "บทความนี้ไม่มีเนื้อหาให้แปล": "This article has nothing to translate",
    "บทความนี้มีแต่โค้ด ไม่มีข้อความให้แปล": "This article is only code; there is no text to translate",
    "แปลบทนี้ไม่ได้": "This lecture cannot be translated",
    "กำลังตรวจคำบรรยายของบทนี้ ...": "Checking this lecture's captions ...",
    "เริ่มดูได้เลย ส่วนที่เหลือกำลังแปลอยู่เบื้องหลัง": "Ready to watch; the rest is translating in the background",
    "พร้อมแล้ว ซับไทยครบทั้งบท": "Ready: Thai subtitles for the whole lecture",
    "{message} ลองใหม่ใน {seconds} วินาที": "{message} Retrying in {seconds} seconds",
    "{message} หยุดลองแล้ว กด F5 เพื่อเริ่มใหม่": "{message} Stopped retrying; press F5 to start again",
    "แปลล่วงหน้าทั้ง Section ใช้ได้เฉพาะบน Udemy": "Translating a whole section ahead works only on Udemy",
    "กำลังเตรียมคิวอยู่แล้ว": "The queue is already being prepared",
    "โหลดเสียง {engine} ไม่สำเร็จ: {reason}": "Could not load the {engine} voice: {reason}",
    "พากย์เสียงไม่ได้: {reason}": "Dubbing failed: {reason}",
    "เล่นไฟล์เสียงไม่ได้": "Could not play the audio",

    // ---- waiting card
    "แปลซับ: พร้อมแล้ว {ready}/{needed} วินาที (ท่อน {done}/{total})":
      "Subtitles: {ready}/{needed} seconds ready (part {done}/{total})",
    "แปลซับ: พร้อมแล้ว {ready}/{needed} วินาที": "Subtitles: {ready}/{needed} seconds ready",
    "โหลดเสียงพากย์ {engine} ขึ้นการ์ดจอ": "Loading the {engine} voice onto the GPU",
    "กำลังแปลช่วงที่คุณกรอไป ...": "Translating the part you skipped to ...",
    "กำลังเตรียมซับและเสียงพากย์ ...": "Preparing subtitles and dubbing ...",
    "กำลังเตรียมเสียงพากย์ช่วงนี้ ...": "Preparing the dub for this part ...",
    "วิดีโอจะเล่นต่อเองในอีกไม่กี่วินาที": "The video resumes by itself in a few seconds",
    "กำลังแปลเป็นไทย ...": "Translating into Thai ...",
    "กำลังโหลดเสียงพากย์ ...": "Loading the dub voice ...",
    "AI กำลังแปลช่วงนี้ก่อนส่วนอื่น วิดีโอจะเล่นต่อเองเมื่อพร้อม หรือกดดูต่อโดยไม่รอได้":
      "The AI is translating this part first. The video resumes by itself when ready, or keep watching without waiting",
    "วิดีโอจะเล่นต่อเองเมื่อแปลล่วงหน้าพอ ที่เหลือแปลต่อเบื้องหลัง":
      "The video resumes by itself once enough is translated; the rest continues in the background",
    "ครั้งแรกหลังเปิดเซิร์ฟเวอร์ใช้เวลาราว 15-60 วินาที วิดีโอจะเล่นต่อเองเมื่อพร้อม":
      "The first time after starting the server takes about 15-60 seconds. The video resumes by itself when ready",
    "ข้ามการรอ แล้วดูไปก่อน": "Skip the wait and watch now",
    "แปลด่วน": "Quick",

    // ---- quizzes, assignments, articles, sections (Udemy)
    "กำลังแปลคำสั่ง Assignment {count} บรรทัดเป็นไทย ...": "Translating {count} lines of the assignment into Thai ...",
    "กำลังแปลคำสั่ง Assignment ...{progress}": "Translating the assignment ...{progress}",
    "กำลังแปลแบบทดสอบ {count} ข้อเป็นไทย ...": "Translating {count} quiz questions into Thai ...",
    "กำลังแปลแบบทดสอบ ...{progress}": "Translating the quiz ...{progress}",
    "แปลแล้ว {count} ข้อความ — คำแปลไทยจะขึ้นใต้ข้อความอังกฤษ":
      "Translated {count} texts. The Thai appears under the English",
    "กำลังแปลเอกสาร {count} ย่อหน้าเป็นไทย ...": "Translating {count} paragraphs into Thai ...",
    "กำลังแปลเอกสาร ...{progress}": "Translating the article ...{progress}",
    "ฉบับแปลไทย": "Thai translation",
    "ฉบับแปลไทย ({count} ย่อหน้า)": "Thai translation ({count} paragraphs)",
    "ดูต้นฉบับอังกฤษ": "Show the English original",
    "ซ่อนต้นฉบับอังกฤษ": "Hide the English original",
    "เปิดบทเรียนสักบทก่อน แล้วค่อยสั่งแปลทั้ง Section": "Open a lecture first, then translate its section",
    "กำลังอ่านรายการบทเรียนใน Section ...": "Reading the lectures in this section ...",
    "หา Section ของบทเรียนนี้ไม่เจอ": "Could not find this lecture's section",
    "Section นี้ไม่มีวิดีโอหรือบทความให้แปล": "This section has no videos or articles to translate",
    "กำลังเตรียม {done}/{total} บทเรียน": "Preparing {done}/{total} lectures",
    "Section นี้แปลไว้หมดแล้ว ({count} บทเรียน)": "This section is already translated ({count} lectures)",
    "ไม่มีบทเรียนที่แปลได้": "No lectures can be translated",
    "ปิดกล่องสถานะ": "Close status",
    "แปลล่วงหน้าเสร็จ — พลาด {failed} บทเรียน": "Done translating ahead; {failed} lectures failed",
    "แปลล่วงหน้าเสร็จแล้ว เปิดบทถัดไปได้เลย": "Done translating ahead. Go ahead to the next lecture",

    // ---- reading captions
    "อ่านรายการคำบรรยายไม่ได้": "Could not read the caption list",
    "YouTube ตอบ {status}": "YouTube answered {status}",
    "อ่านรหัสคอร์สจาก URL ไม่ได้": "Could not read the course from the URL",
    "หา course id ไม่เจอ": "Could not find the course id",
    "อ่านรหัสบทเรียนจาก URL ไม่ได้": "Could not read the lecture from the URL",
  };

  // Engine and voice names as the server lists them (udemy_th/*_tts.py).
  // tests/test_voices.py keeps this list and the server's in step.
  const SERVER_LABELS_EN = {
    "Microsoft Edge Neural (ฟรีไม่จำกัด)": "Microsoft Edge Neural (free, unlimited)",
    "Meta SeamlessM4T (รันในเครื่อง / แปลเสียงเองได้)": "Meta SeamlessM4T (runs locally / translates by itself)",
    "OmniVoice Thai (รันในเครื่อง / ต้องมี GPU)": "OmniVoice Thai (runs locally / needs a GPU)",
    "ThonburianTTS megaF5 (A100 / โคลนเสียงได้)":
      "ThonburianTTS megaF5 (A100 / voice cloning)",
    "OpenJaiTTS v1 (A100 / โคลนเสียงได้)": "OpenJaiTTS v1 (A100 / voice cloning)",
    "Niwat — ชาย": "Niwat — male",
    "Premwadee — หญิง": "Premwadee — female",
    "Gacrux — หญิง": "Gacrux — female",
    "Iapetus — ชาย": "Iapetus — male",
    "Orus — ชาย": "Orus — male",
    "Meta Seamless (เสียงไทยธรรมชาติ / Reels)": "Meta Seamless (natural Thai voice / Reels)",
    "ชาย (เสียงทุ้ม)": "Male (deep)",
    "หญิง": "Female",
    "ชาย (วัยหนุ่ม เสียงกลาง)": "Male (young, mid-pitch)",
    "หญิง (เสียงทุ้ม นุ่ม)": "Female (deep, soft)",
    "เสียงมาตรฐาน": "Standard voice",
    "โคลนเสียงจากไฟล์ตัวอย่าง": "Clone a voice from a sample file",
  };

  const TABLES = { en: { ...SERVER_LABELS_EN, ...EN } };
  let current = "th";

  /** "auto" follows the browser: Thai for a Thai browser, English otherwise. */
  function resolve(preference, browserLanguage = globalThis.navigator && globalThis.navigator.language) {
    if (preference === "th" || preference === "en") return preference;
    return /^th\b/i.test(browserLanguage || "") ? "th" : "en";
  }

  function setLang(preference) {
    current = resolve(preference);
    if (globalThis.document && document.documentElement && document.documentElement.dataset) {
      // Only our own pages: on Udemy/YouTube the page's lang is not ours to change.
      if (document.documentElement.dataset.udthOwnPage !== undefined) document.documentElement.lang = current;
    }
    return current;
  }

  function t(text, vars) {
    const table = TABLES[current];
    let out = (table && table[text]) || text;
    if (vars) out = out.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
    return out;
  }

  /** A server engine entry with its names in the interface language. */
  function localizeEngine(engine) {
    return {
      ...engine,
      label: t(engine.label),
      voices: (engine.voices || []).map((voice) => ({ ...voice, label: t(voice.label) })),
    };
  }

  UDTH.i18n = { t, setLang, resolve, localizeEngine, lang: () => current, EN, SERVER_LABELS_EN };
  if (typeof module !== "undefined") module.exports = UDTH.i18n;
})();
