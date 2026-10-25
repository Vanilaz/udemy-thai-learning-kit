# เลือกเสียงพากย์ไทย

เซิร์ฟเวอร์รองรับหลาย engine พร้อมกัน เลือกได้จาก **แผงควบคุมมุมขวาบนของวิดีโอ → ⚙**
หรือจาก popup ของส่วนขยาย

รายการ engine ไม่ได้ฝังไว้ในส่วนขยาย แต่ถามจากเซิร์ฟเวอร์ทุกครั้งที่เปิดหน้า
ติดตั้ง engine ใหม่ที่ฝั่ง Python แล้วมันจะโผล่ในตัวเลือกเอง ไม่ต้องแก้ extension

| engine | ฟรีไหม | คุณภาพ | ต้องเตรียมอะไร |
|---|---|---|---|
| **edge** | ไม่จำกัด | Azure Neural | `pip install -r requirements.txt` เท่านั้น |
| **windows** | ไม่จำกัด | เท่ากับ edge | ไม่ต้องเตรียมอะไร แต่ cache ไม่ได้ |
| **google** | 1 ล้านตัวอักษร/เดือน | สูงสุด (คลาวด์) | บัญชี Google Cloud + service account |
| **thonburian** | ไม่จำกัด | โคลนเสียงได้ · ใบอนุญาตโมเดลห้ามใช้ทางการค้า | Colab A100 หรือ GPU ในเครื่อง + `flowtts` |
| **openjai** | ไม่จำกัด | ชัดเจนเป็นธรรมชาติ (v1.0) + โคลนเสียงได้ | Colab A100 หรือ GPU ในเครื่อง + `flowtts` |
| **omnivoice** | ไม่จำกัด | ดี + โคลนเสียงได้ (600+ ภาษา) | Colab A100 หรือ GPU ในเครื่อง + `pip install omnivoice soundfile` |
| **seamless** | ไม่จำกัด | Meta SeamlessM4T (สไตล์ Facebook Reels) | Colab A100 หรือ GPU ในเครื่อง + `pip install transformers soundfile sentencepiece` |

---

## รันโมเดลเสียงไทยและ ASR บน Colab A100 (แนะนำเมื่อไม่มี GPU แรงๆ ในเครื่อง)

ถ้าต้องการให้ **`agy` แปลซับในเครื่องเหมือนเดิม** แต่ให้โมเดลเสียงไทยตัวใหญ่ (**ThonburianTTS megaF5**, **OpenJaiTTS v1.0**, **OmniVoice Thai**, **SeamlessM4T-v2-large**) และโมเดลถอดเสียง **Typhoon Whisper Turbo / Whisper Large-v3 Turbo** ไปรันบน **Colab A100 GPU**:

1. เปิดโน้ตบุ๊ก [`colab/hongrian_voice_a100.ipynb`](../colab/hongrian_voice_a100.ipynb) บน Google Colab เลือก Runtime เป็น **A100 GPU** แล้วกด **Run all**
2. คัดลอกค่า `UDTH_A100_URL` และ `UDTH_A100_KEY` ที่โน้ตบุ๊กพิมพ์ออกมาไปวางในไฟล์ `.env`
3. เปิด `start-server.cmd` ใหม่ — เซิร์ฟเวอร์จะส่งงานสังเคราะห์เสียงและถอดเสียงไปที่ A100 อัตโนมัติ พร้อมระบบ **Batch Prefetch** สร้างเสียงพากย์ล่วงหน้าแบบขนานทันทีที่ `agy` แปลซับเสร็จแต่ละท่อน
4. **Circuit Breaker & Auto-Fallback:** หาก Colab A100 หลุดหรือปิดไปกลางคัน เซิร์ฟเวอร์จะสลับไปใช้เสียงสำรองในเครื่อง (`edge` — Microsoft Azure Neural) ทันทีโดยวิดีโอไม่สะดุด และลองเชื่อม A100 ใหม่อัตโนมัติทุก 60 วินาที

---

## thonburian & openjai — เสียงพากย์ไทย F5-TTS (โคลนเสียงได้)

- **ThonburianTTS (megaF5)** ([`biodatlab/ThonburianTTS`](https://huggingface.co/biodatlab/ThonburianTTS) โดย Looloo Technology, WordSense และ Biomedical and Data Lab (มหิดล)) — F5-TTS ที่ปรับมาเพื่อภาษาไทย โคลนเสียงได้ ใบอนุญาต CC BY-NC-SA 4.0 (ใบอนุญาตโมเดลห้ามใช้ทางการค้า)
- **OpenJaiTTS (v1.0)** (`OpenJai/OpenJaiTTS-v1.0`) — โมเดล F5-TTS ภาษาไทยที่เน้นความคมชัดของเสียงพูด เหมาะกับบทเรียนบรรยาย

ใช้งานได้ 2 วิธี:
1. **ผ่าน Colab A100 (แนะนำ):** ตั้งค่า `UDTH_A100_URL` และ `UDTH_A100_KEY` จาก `colab/hongrian_voice_a100.ipynb` ไม่ต้องลงไลบรารีหนักในเครื่อง
2. **รันบนการ์ดจอในเครื่อง:**
   ```cmd
   python -m pip install flowtts soundfile torchaudio
   ```

ทั้งสองตัวรองรับการ**โคลนเสียงผู้สอนแบบ Zero-shot** เพียงตั้งค่า `UDTH_VOICE_REF=C:\voices\instructor.wav` ใน `.env` แล้วเลือกเสียง **โคลนเสียงผู้สอน (จากไฟล์ตัวอย่าง)** (หากรันผ่าน A100 เซิร์ฟเวอร์จะส่งไฟล์ตัวอย่างขึ้น A100 ครั้งเดียวและใช้ Typhoon Whisper ถอดความเสียงตัวอย่างให้อัตโนมัติ)

---

## edge — แนะนำสำหรับคอร์สยาว (ไม่ต้องใช้ GPU)

```cmd
python -m pip install -r requirements.txt
```

จบ ไม่ต้องมี API key ไม่ต้องมีบัญชี ไม่มีโควต้า

เสียงที่ได้: `th-TH-NiwatNeural` (ชาย) และ `th-TH-PremwadeeNeural` (หญิง)
— **คือเสียงเดียวกับ "Niwat Online (Natural)" ที่ Windows มีให้** เพราะเป็น Azure Neural
ตัวเดียวกัน ต่างกันแค่ตรงที่เรียกจากเซิร์ฟเวอร์แทนเบราว์เซอร์

> เป็น endpoint ของ Edge ที่ไม่ใช่ API สาธารณะ วันหนึ่งอาจถูกปิด จึงเก็บ engine
> อื่นไว้ให้สลับได้ ไม่ได้ทำเป็นทางเดียว

## windows — ไม่ต้องติดตั้งอะไรเลย

ใช้เสียงไทยที่ Windows มีอยู่ผ่าน `speechSynthesis` ของเบราว์เซอร์

ข้อเสียที่ควรรู้: เสียงถูกสร้างในเบราว์เซอร์ จึง **cache ไม่ได้ และเตรียมล่วงหน้าไม่ได้**
ดูบทเดิมซ้ำก็ต้องสังเคราะห์ใหม่ทุกครั้ง และสั่งแปลล่วงหน้าทั้ง Section แล้วเตรียมเสียงรอไว้ไม่ได้
ถ้าจะดูคอร์สยาวๆ ให้ใช้ `edge` แทน — เสียงเดียวกันแต่ได้ cache

## google — คุณภาพสูงสุดบนคลาวด์

ดู [google-cloud-tts.md](google-cloud-tts.md) — ใช้ service account JSON ไม่ใช่ API key

Chirp 3 HD รับข้อความได้ครั้งละ ~900 ไบต์ (ไทยประมาณ 300 ตัวอักษร) ถ้าเกินจะตอบ 400
พร้อมข้อความว่า "sentences that are too long" และแนะนำให้ใส่จุด — ซึ่งไม่ช่วย เพราะขีดจำกัด
อยู่ที่ทั้งคำขอ ไม่ใช่ที่ประโยค (วัดจริง: 880 ไบต์ผ่าน 950 ไบต์ไม่ผ่าน ไม่ว่าจะแบ่งประโยคหรือไม่)

ปัญหานี้เจอบน YouTube แต่ไม่เจอบน Udemy เพราะซับของ Udemy มีเครื่องหมายวรรคตอน
ช่วงพากย์จึงจบเป็นประโยคและสั้นอยู่แล้ว ส่วนซับอัตโนมัติของ YouTube ไม่มีวรรคตอนเลย
ช่วงพากย์จึงยาวจนชนเพดาน 14 วินาที และข้อความไทยที่ได้ก็เกินขีดจำกัด

ตอนนี้ `google_tts.py` แบ่งข้อความให้เองก่อนส่ง (แบ่งที่เว้นวรรคก่อน ถ้าไม่มีจึงตัดกลางคำ
โดยไม่ตัดคร่อมสระหรือวรรณยุกต์) ถ้าแบ่งแล้วได้หลายชิ้นจะขอเป็น LINEAR16 แล้วต่อเป็น `.wav`
ไฟล์เดียว — ไม่ใช่ MP3 เพราะต้องได้ header ที่ตรงกับเสียงจริง ไม่งั้นเบราว์เซอร์อ่าน
`audio.duration` ผิด แล้วการเร่งเสียงให้พอดีช่วงจะเพี้ยนตาม

## seamless — Meta SeamlessM4T (พากย์เสียงสไตล์ Facebook Reels)

โมเดล [facebook/hf-seamless-m4t-medium](https://huggingface.co/facebook/hf-seamless-m4t-medium) (หรือ `facebook/seamless-m4t-v2-large` บน Colab A100) โดย Meta สำหรับการสังเคราะห์เสียง แปล และพากย์หลายภาษา (รองรับโหมด **เริ่มทันที** แปลและพากย์จากต้นฉบับได้โดยไม่ต้องรอ AI)

```cmd
python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
python -m pip install transformers soundfile sentencepiece protobuf
```

- รันบน Colab A100 (ผ่าน `UDTH_A100_URL`) หรือบน GPU ในเครื่อง 100% ฟรีไม่จำกัด
- ปรับเปลี่ยนโมเดลในเครื่องได้ผ่าน Environment Variable เช่น:
  ```cmd
  set UDTH_SEAMLESS_MODEL=facebook/seamless-m4t-v2-large
  ```
  (แนะนำโมเดล `v2-large` สำหรับ Colab A100 หรือการ์ดจอ VRAM 12GB+ เช่น RTX 4080 / 4090)

---

## omnivoice — รันบน A100 หรือในเครื่อง โคลนเสียงผู้สอนได้

โมเดล [hotdogs/omnivoice-thai](https://huggingface.co/hotdogs/omnivoice-thai) (Apache-2.0)
ขนาด 0.6B fine-tune จาก [k2-fsa/OmniVoice](https://github.com/k2-fsa/OmniVoice)

```cmd
python -m pip install omnivoice soundfile
```

เหมาะกับ Colab A100 หรือเครื่องที่มีการ์ดจอ — RTF ที่รายงานไว้คือ 0.025 (เร็วกว่าเวลาจริงราว 40 เท่า)
บทเรียนหนึ่งชั่วโมงจึงใช้เวลาสร้างเสียงระดับสิบวินาที

โมเดลถูกโหลดตอนเรียกใช้ครั้งแรก ไม่ใช่ตอนเปิดเซิร์ฟเวอร์ เครื่องที่ไม่มี GPU
จึงเปิดเซิร์ฟเวอร์ได้ตามปกติ

### โคลนเสียงผู้สอน (ใช้ได้กับ ThonburianTTS, OpenJaiTTS และ OmniVoice)

ตัดเสียงผู้สอนมาสัก 5-10 วินาที (ไฟล์ wav หรือ mp3) แล้วตั้งใน `.env`:

```ini
UDTH_VOICE_REF=C:\voices\instructor.wav
```
(หรือใช้ชื่อตัวแปรเดิม `UDTH_OMNIVOICE_REF` ก็ได้)

เปิดเซิร์ฟเวอร์ใหม่ แล้วเลือกเสียง **โคลนเสียงผู้สอน (จากไฟล์ตัวอย่าง)** หรือ **โคลนเสียงจากไฟล์ตัวอย่าง**

ไฟล์ตัวอย่างถูกนับเป็นส่วนหนึ่งของกุญแจ cache ด้วย เปลี่ยนไฟล์แล้วจะไม่ได้เสียงเดิมคืนมา

เลือกโมเดลอื่นได้ด้วย `set UDTH_OMNIVOICE_MODEL=<ชื่อโมเดลบน HuggingFace>`

> โคลนเสียงคนอื่นไปเผยแพร่เป็นเรื่องละเอียดอ่อน ใช้กับคอร์สที่ซื้อแล้วเพื่อฟังเองเท่านั้น
> อย่าเอาเสียงที่โคลนได้ไปทำอย่างอื่น

---

## เพิ่ม engine เอง

เขียนคลาสที่มี 5 อย่างนี้ แล้วเติมหนึ่งบรรทัดใน `_build` ของ `udemy_th/tts.py`

```python
class MyTts:
    name = "myengine"
    label = "ชื่อที่ผู้ใช้เห็น"
    voices = {"voice-id": "ป้ายชื่อเสียง"}

    def status(self) -> dict:      # ห้าม raise
        return {"configured": True, "unlimited": True}

    def synthesize(self, text: str, voice: str | None) -> dict:
        return {"file": "abc.mp3", "cached": False}   # ไฟล์อยู่ใน cache/audio/
```

`voice id` คือกุญแจที่ใช้เลือก engine ดังนั้นต้องไม่ซ้ำกับ engine อื่น
ส่วนขยายไม่เคยส่งชื่อ engine มาเลย จึงไม่มีทางที่ engine กับเสียงจะไม่ตรงกัน

import ของ dependency ต้องอยู่ **ในเมธอด** ไม่ใช่หัวไฟล์ เพราะทุก engine ถูกสร้าง
ตอนเปิดเซิร์ฟเวอร์บนเครื่องที่อาจไม่ได้ติดตั้งอะไรเลย

## ทำไมเสียงเคยเงียบบน YouTube แต่ปกติบน Udemy

Chrome (ตั้งแต่ ~เวอร์ชัน 138) กั้นไม่ให้เว็บสาธารณะเรียกที่อยู่ในเครือข่ายบ้าน
รวมถึง `127.0.0.1` ไว้หลังสิทธิ์ **Local Network Access** ซึ่งให้เป็นราย
เว็บไซต์ ตรวจสถานะได้ในหน้านั้นๆ ด้วย

```js
(await navigator.permissions.query({name: 'local-network-access'})).state
```

ที่วัดได้จริงบนเครื่องนี้ (Chrome 151):

| เว็บ | สิทธิ์ | `fetch` ไป 127.0.0.1:8765 | `<audio src="http://127.0.0.1...">` |
|---|---|---|---|
| udemy.com | `granted` | HTTP 200 | ทำงาน |
| youtube.com | `prompt` | ถูกบล็อก (503) | **ค้าง ไม่มีทั้ง load และ error** |

อาการที่ออกมาจึงหลอกมาก: ไม่มี error ให้เห็นเลย `<audio>` แค่ค้างอยู่เฉยๆ จน
watchdog 45 วินาทีข้ามไป ผลคือเงียบสนิท และ Windows Natural ยังใช้ได้อยู่เพราะ
มันพูดผ่าน `speechSynthesis` ในเบราว์เซอร์ ไม่แตะเซิร์ฟเวอร์เลย เลยดูเหมือน
เป็นบั๊กของ engine เสียง ทั้งที่เป็นเรื่องเครือข่าย

ทางแก้คือ **หน้าเว็บไม่ต้องต่อเซิร์ฟเวอร์เอง** — service worker ของ extension
(ซึ่งมี host permission และไม่ติดข้อจำกัดนี้) อ่านไฟล์เสียงมาแล้วส่งเป็น bytes
ให้ content script ทำเป็น blob URL แทน หน้าเว็บจึงเล่นไฟล์ที่ตัวเองถืออยู่
ไม่ต้องขอสิทธิ์อะไรทั้งนั้น และใช้ได้กับทุกเว็บ ไม่ใช่เฉพาะที่เคยกดอนุญาตไว้
