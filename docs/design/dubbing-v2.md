# ออกแบบระบบใหม่: ซับไทย + พากย์ไทย v2

สถานะ: **ทำแล้วในเวอร์ชัน 1.0.0** · 2026-10-11 (ดู CHANGELOG.md)

> โครงไฟล์จริงต่างจากข้อ 4 เล็กน้อย: speech + player รวมเป็น `pipeline/dubber.js` + `pipeline/voices.js`,
> text pipeline อยู่ใน `pipeline/session.js` และ API ของเซิร์ฟเวอร์ยังใช้ path เดิม (เพิ่ม `/tts/warmup`, `version`, `translates`)
> เพราะ seam ที่มีสอง adapter จริงมีแค่ site และ voice ตามหลัก deep module

## 1. ทำไมต้องออกแบบใหม่

ระบบปัจจุบันโตจากการเติมฟีเจอร์ทีละชิ้น จนกลไกพันกัน (วัดจากโค้ดจริง):

| ปัญหา | หลักฐาน | ผลที่ผู้ใช้เจอ |
|---|---|---|
| ไฟล์เดียวทำทุกอย่าง | `content.js` 3,041 บรรทัด 17 ส่วน (ดึงซับ, แปล, กล่องรอ, ซับ, พากย์, เมนู, quiz, article ...) | แก้จุดหนึ่งพังอีกจุด — merge ครั้งก่อนทำโค้ดซ้ำ 937 บรรทัด |
| แผนพากย์ถูกสร้างใหม่ 6 จุด | `state.dub.segments = ...` 6 ที่ ประโยคถูกแบ่งใหม่ทุกครั้งที่คำแปลทยอยมา | index เลื่อน ต้องมี `updateDubSegments` มาอุด เสียงเคยขาดทุก 1.5 วินาที |
| กล่องรอใช้ร่วมหลายเหตุผล | `showGate/hideGate` 19 จุด: รอแปล / รอโมเดล / error | ปิดกล่องของอีกเหตุผลผิดจังหวะ |
| เสียงพากย์ผูกกับการแปลซับ | ต้องรอ AI แปลซับล่วงหน้า 90 วินาทีก่อนวิดีโอเล่น แม้ Seamless พากย์จากต้นฉบับได้ทันที | รอ ~90 วินาทีโดยไม่จำเป็น |
| ความสามารถของ engine เป็น flag กระจัดกระจาย | `translates`, `warm()`, เช็กชื่อ `"windows"` ในหลายที่ | เลือกเสียงอัตโนมัติไปลง Edge, popup บันทึกเสียงข้าม engine |
| การตั้งค่าไม่มี schema กลาง | เขียน storage จาก popup และเมนูคนละชุดคีย์ | ค่าผิดค้างใน storage (Seamless + เสียง Edge) |

## 2. หลักการออกแบบ

1. **ข้อความ กับ เสียง เป็นสองสายงานแยกกัน** — สายแปลข้อความ (ซับ) กับสายเสียง (พากย์) ไม่รอกัน เชื่อมกันผ่าน "ไทม์ไลน์ประโยค" เท่านั้น
2. **ไทม์ไลน์ประโยคสร้างครั้งเดียว ไม่เปลี่ยนอีก** — แบ่งประโยคจาก*ต้นฉบับ*ตอนโหลดบทเรียน ทุกประโยคมี id คงที่ คำแปล/เสียงมา "แปะ" ลงประโยค ไม่ใช่สร้างแผนใหม่
3. **คุณภาพเป็นข้อมูล ไม่ใช่โหมด** — ทุกคำแปล/เสียงมีป้าย `draft` (Seamless, เร็ว) หรือ `final` (AI + คลังศัพท์, แม่น) ของ `final` แทน `draft` เสมอ
4. **Engine ประกาศความสามารถ** — เซิร์ฟเวอร์บอกว่าแต่ละ engine ทำอะไรได้ (`tts`, `t2st`, `t2tt`, `needs_warmup`) ฝั่งหน้าเว็บตัดสินใจจากความสามารถ ไม่ใช่จากชื่อ
5. **สถานะเดียว แหล่งความจริงเดียว** — การตั้งค่ามี schema + version + migration ใช้ร่วมกันทั้ง popup และเมนู
6. **ทุกการรอต้องมีเหตุผลที่ระบุได้** — กล่องรอแสดง "รอเพราะอะไร" จาก state machine เดียว

## 3. สถาปัตยกรรม

```
 หน้า Udemy / YouTube (content scripts)                       เซิร์ฟเวอร์ในเครื่อง (Python)
 ┌───────────────────────────────────────────┐              ┌──────────────────────────────┐
 │ SiteAdapter (udemy | youtube)             │              │ /v1/engines   ความสามารถ+สถานะ │
 │   → Transcript {lang, origin, cues}       │              │ /v1/engines/{n}/warmup        │
 │                                           │              │                              │
 │ Timeline  ประโยคคงที่ (id, เวลา, ต้นฉบับ)    │◄── final ────│ /v1/translate  (AI + glossary)│
 │   แต่ละประโยค: text{draft,final}            │              │   job + stream ทีละท่อน        │
 │                audio{draft,final}          │◄── draft ────│ /v1/speech     TTS | T2ST     │
 │                                           │   (+ข้อความ)  │   {text|source, lang, voice}  │
 │ TextPipeline   ขอคำแปล AI → final           │              │   → audio + spoken text       │
 │ SpeechPipeline ขอเสียงล่วงหน้าตามตำแหน่งเล่น    │              │                              │
 │ Player         เล่นเสียงตามเวลาวิดีโอ          │              │ EngineRegistry               │
 │ ReadinessGate  state machine ของ "รอเพราะ"   │              │   edge | google | omnivoice   │
 │ UI: Overlay · Menu · Gate                 │              │   seamless (tts+t2st+t2tt)    │
 │ Settings (schema v2, ใช้ร่วม popup)          │              └──────────────────────────────┘
 └───────────────────────────────────────────┘
```

### 3.1 ไทม์ไลน์ประโยค (หัวใจของระบบ)

```ts
Sentence {
  id: string            // คงที่ตลอดบทเรียน: hash(lectureId, start)
  start, end, budgetEnd // วินาที
  source: { text, lang }            // ต้นฉบับ ไม่เปลี่ยน
  text:  { draft?: string, final?: string }   // ซับไทย
  audio: { [voiceKey]: { quality: "draft"|"final", url } }
}
```

- ซับที่แสดง = `final ?? draft ?? source` (draft แสดงเป็นสีจาง + ป้าย "แปลด่วน")
- เสียงที่เล่น = เสียง `final` ถ้ามี ไม่งั้น `draft` (ถ้าโหมดอนุญาต)
- แคชเสียง key = `sentenceId + voice + hash(ข้อความที่พูด)` → เปลี่ยนเสียง/คำแปลไม่ทำให้เล่นไฟล์ผิด และไม่ต้องล้างทั้งแคช

### 3.2 สองโหมดเริ่มเล่น (ผู้ใช้เลือกด้วยเป้าหมาย)

| | ⚡ เริ่มทันที | 🎯 แม่นยำ |
|---|---|---|
| วิดีโอเริ่มเล่นเมื่อ | โมเดลเสียงพร้อม (เกือบทันที) | AI แปลล่วงหน้าครบ 90 วินาที |
| ซับช่วงแรก | คำแปลด่วนของ Seamless → แทนด้วยคำแปล AI เมื่อมาถึง | คำแปล AI |
| เสียงช่วงแรก | Seamless แปล+พากย์จากต้นฉบับ (T2ST) | อ่านคำแปล AI (TTS) |
| ใช้ได้กับเสียง | Seamless เท่านั้น | ทุกเสียง |
| ค่าเริ่มต้น | ✓ เมื่อมี Seamless | เมื่อไม่มี Seamless |

ทั้งสองโหมด AI ยังแปลซับเบื้องหลังเสมอ — โหมดต่างกันแค่ "เริ่มเล่นเมื่อไหร่" และ "ระหว่างรอใช้อะไร"

### 3.3 ReadinessGate — state machine เดียว

```
idle → loading-transcript → (no-captions | native-thai | error)
                         → waiting{reasons:Set<"translation"|"voice-model"|"server">}
                         → playing
```

กล่องรอแสดงเหตุผลทั้งหมดที่ยังค้าง (เช่น "รอโมเดลเสียง · รอคำแปล 40/90 วินาที") มีจุดเดียวที่เปิด/ปิดกล่อง

### 3.4 API เซิร์ฟเวอร์ v1

| Endpoint | หน้าที่ |
|---|---|
| `GET /v1/engines` | `[{name, label, voices, caps:{tts,t2st,t2tt}, warmup:{state,error}, quota}]` |
| `POST /v1/engines/{name}/warmup` | เริ่มโหลดโมเดล คืนสถานะ (เรียกซ้ำได้) |
| `POST /v1/translate` · `GET /v1/jobs/{id}` | แปลซับด้วย AI แบบ job + ผลทยอย (ของเดิม ย้าย path) |
| `POST /v1/speech` | `{voice, text}` หรือ `{voice, source:{text,lang}}` → `{url, quality, spoken_text}` |

endpoint เดิม (`/health`, `/tts`, `/tts/warmup`, `/translate`, `/job/*`) คงไว้เป็น shim หนึ่งเวอร์ชัน เพื่อไม่ให้ extension เก่าพัง

### 3.5 การตรวจภาษาต้นฉบับ

| แหล่ง | สัญญาณ | ลำดับเลือกซับต้นทาง |
|---|---|---|
| Udemy | `course.locale` (ยืนยันกับ API จริงแล้ว: `{"locale":"en_US"}`) | คนทำ-ภาษาผู้สอน → คนทำ-อังกฤษ → อัตโนมัติ-ภาษาผู้สอน → อื่นๆ |
| YouTube | ภาษาของ track ถอดเสียงอัตโนมัติ (= ภาษาที่พูด) | คนทำ-ภาษาที่พูด → คนทำ-อังกฤษ → ถอดเสียงอัตโนมัติ |

ภาษาที่ตรวจพบแสดงในเมนู ("ES → ไทย") และส่งต่อให้ทั้ง AI และ Seamless

### 3.6 การตั้งค่า (schema v2)

```js
{ v: 2, subtitles: "off"|"th"|"both", textSize: "s"|"m"|"l",
  dub: { on, engine, voice /* ต้องอยู่ใน engine */, start: "instant"|"accurate",
         dubVolume, sourceVolume, maxRate } }
```

โมดูลเดียว (`settings.js`) โหลดได้ทั้ง popup และหน้าเว็บ: อ่าน → migrate v1 → validate (เช่นเสียงต้องอยู่ใน engine ที่เลือก) → เขียน หน้าอื่นฟังผ่าน `chrome.storage.onChanged` แทนการส่งข้อความหากัน

## 4. โครงสร้างไฟล์ extension

ไม่ต้องมี build step — โหลดเป็น content scripts หลายไฟล์ตามลำดับใน manifest (แบบเดียวกับ `sites.js` ที่ใช้อยู่)

```
extension/
  core/settings.js     schema, migrate, validate, storage
  core/timeline.js     Sentence model, แบ่งประโยค, merge คำแปล
  core/api.js          client ของ /v1 (ผ่าน background)
  pipeline/text.js     ขอ/รับคำแปล AI ทยอย
  pipeline/speech.js   ขอเสียงล่วงหน้า, แคช
  pipeline/player.js   เล่นเสียงตามเวลา, fit rate, hold
  pipeline/gate.js     ReadinessGate state machine
  sites/udemy.js · sites/youtube.js
  ui/overlay.js · ui/menu.js · ui/gate-view.js
  modes/quiz.js · modes/article.js · modes/assignment.js
  main.js              ประกอบทุกส่วน (≈150 บรรทัด)
```

แต่ละโมดูลมี interface เล็ก ทดสอบแยกได้ด้วย node:test โดยไม่ต้องมีเบราว์เซอร์

## 5. แผนการทำ (แต่ละขั้นส่งมอบได้ ใช้งานได้จริงทุกขั้น)

| ขั้น | งาน | เกณฑ์เสร็จ |
|---|---|---|
| 0 | commit งานแก้บัคปัจจุบันลง branch, ตัดสินเทสต์เก่าของ master 16 ตัว (ย้ายมาใช้กับโครงใหม่ หรือเลิกใช้พร้อมเหตุผล) | เทสต์ทั้งหมดเขียว |
| 1 | Server API v1 + capability + `/v1/speech` คืน `spoken_text` + shim ของเดิม | contract tests ผ่าน, extension เดิมยังใช้ได้ |
| 2 | `settings.js` + migration + ใช้ร่วม popup/เมนู | ไม่มีการเขียน storage จากที่อื่น |
| 3 | `timeline.js` + `text.js` (ประโยคคงที่, draft/final) | unit tests: คำแปลทยอยไม่ทำให้ id เปลี่ยน |
| 4 | `speech.js` + `player.js` (แคชตาม id+เสียง+ข้อความ) | ไม่มีเสียงขาดตอนคำแปลทยอย, เปลี่ยนเสียงกลางคลิปได้ |
| 5 | `gate.js` + โหมด ⚡/🎯 | เริ่มทันทีเล่นได้ < 5 วินาทีเมื่อโมเดลพร้อม |
| 6 | UI: สวิตช์ ⚡/🎯 ที่แถวพากย์, ซับ draft แบบจาง, กล่องรอบอกเหตุผล | ภาพ preview + ทดสอบบน Udemy/YouTube จริง |
| 7 | E2E: Playwright กับหน้า fixture + mock server; checklist ทดสอบบนเว็บจริง (อังกฤษ/สเปน, Udemy/YouTube, ทุก engine) | ผ่านทุกข้อ |

## 6. นอกขอบเขตรอบนี้ (ศึกษาแยก)

**ASR / S2TT / S2ST** (ใช้*เสียง*ของวิดีโอเป็นต้นทาง) — มีประโยชน์กับวิดีโอที่ไม่มีซับเลย แต่ต้องดึงเสียงจากแท็บ
ผ่าน `chrome.tabCapture` + offscreen document แล้วส่งเสียงสดเข้าเซิร์ฟเวอร์ ยังมีคำถามที่ต้องพิสูจน์ก่อน:
คอร์สที่เข้ารหัส (DRM) จับเสียงได้หรือไม่, ความหน่วง, และการตัดประโยคจากเสียงสด — เสนอทำเป็น spike แยกหลัง v2

## 7. ความเสี่ยง

| ความเสี่ยง | การรับมือ |
|---|---|
| refactor ใหญ่ทำของที่ใช้ได้พัง | ทำทีละขั้น ทุกขั้นต้องทดสอบบนเว็บจริงก่อนไปต่อ, shim API เดิม |
| คำแปลด่วนของ Seamless ผิดศัพท์เทคนิค | แสดงเป็น draft ชัดเจน และถูกแทนด้วยคำแปล AI เสมอ |
| VRAM ไม่พอเมื่อโหลดหลายโมเดล | `UDTH_PRELOAD` เลือกโหลดเฉพาะตัว, แสดง VRAM ใน `/v1/engines` |
