# HongRian (ฮองเรียน) — learn online courses in Thai

[ภาษาไทย](README.md) · **English**

<img src="extension/icons/icon128.png" width="72" align="right" alt="">

For people who've bought a Udemy course but can't keep up with the English.

Open a video and Thai subtitles appear automatically, translated by an AI that understands programming context — not word-for-word translation.
Everything runs on your own machine.

**Supports Udemy and YouTube** — YouTube gets subtitles and dubbing only.
Articles, quizzes, and translating a whole Section ahead are Udemy-only.

---

## Supports 4 kinds of lectures

| Kind | What it does |
|---|---|
| **Video** | Thai subtitles overlay the video in time with the audio, plus Thai dubbing (Udemy / YouTube) |
| **Article** | Translates the whole page, keeping headings, lists, and code unchanged |
| **Quiz** | Adds a Thai translation under the question, the choices, and the answer explanation |
| **Attachments** | Translates downloaded PDF / DOCX / TXT / MD / HTML files |

### The control button in the player bar

No need to open the extension's popup — a **Thai** button is added to the **player's control bar**,
next to the site's own buttons (both Udemy and YouTube). Nothing floats over the video.

Clicking it opens a menu above it, like the player's own settings menu. Inside:

- **Subtitles** — Off / Thai / Thai + original, and text size
- **Thai dubbing** — toggle on or off instantly while watching, and it shows which voice is in use
- **Instant / Accurate** — when using the Seamless voice (see below)
- Choose the voice engine and voice, adjust the volume on both sides, and set a cap on the speed-up
- Retranslate / Translate section · press Esc to close the menu
- **Thai / EN** at the top of the menu — changes the language of the extension's interface (buttons, menus, notifications).
  It defaults to your browser's language; the subtitles and dubbing are always Thai.

The button shows a green dot when something is on, so you can tell at a glance without opening the menu.

Everything set in this menu is saved to the same place as the popup, so the two can never disagree.

> If the control bar can't be found (the site changed its layout), the button appears in the video's bottom-right corner instead.
> That's a fallback so you're never left with no controls at all — not the primary design.

### Instant or Accurate — a choice available when using the Seamless voice

The Thai subtitles are translated by an AI that reads the whole lecture and uses the course's glossary, so they're accurate, but it takes time.
Seamless, on the other hand, translates and speaks Thai from the original by itself instantly, but more literally
(for example, "greeting string" becomes "เส้นคำต้อนรับ" [lit. "greeting line"], while the AI gives "ข้อความทักทาย" ["greeting message"]).

| | Instant | Accurate |
|---|---|---|
| Video plays when | Immediately (once the voice model is ready) | The AI has translated 90 seconds ahead |
| Subtitles at first | Seamless's quick translation (faded color, labeled "Quick") | AI translation |
| Voice at first | Seamless translates and dubs from the original | Reads the AI translation |
| After that | Subtitles and voice switch to the AI translation sentence by sentence as each one finishes | Unchanged |

In both modes, the AI is always translating subtitles in the background. The other voices (Edge, Google, OmniVoice, Windows)
can't translate on their own, so they always use "Accurate" mode.

### Accurate mode: the video pauses while translating, but you don't wait for the whole lecture

Open a new lecture and a box appears in the middle of the screen, showing what's happening and how far along it is, and it keeps the video from playing ahead.
Because the first minute watched without subtitles is a wasted minute.

**But it doesn't wait for the whole lecture to finish translating** — the server sends results out piece by piece. As soon as there are subtitles ready
**90 seconds ahead** of where you are, the video resumes right away, and the rest keeps translating in the background.
The box also tells you how many seconds are ready so far.

This is measured from where you're currently watching, not by counting lines, because the chunks finish translating out of order —
if the middle chunk finishes first but you're still at the start of the clip, it still won't let go. And if less than 90 seconds of the clip remains
but translation already reaches the end, it releases right away instead of waiting for time that will never come.

If the server stalls, press **Skip the wait and watch now** — you're never stuck on a screen you can't click out of.

> This applies to `--engine agy` (the default). `--engine claude` still delivers everything at once at the end.

### When Thai subtitles already exist

Udemy has two kinds of Thai subtitles, and their quality differs a lot. This tool tells them apart (YouTube follows the same rule):

- **Human-translated** (`manual`) → **Not retranslated.** You're told to press CC and pick Thai, because it's better than the AI.
- **Auto-generated** (`auto`) → **Retranslated.** It's a machine translation layered on top of a machine transcription —
  errors compound twice. For example, if the transcription mis-hears "async" as "a sink", it will faithfully translate that as "อ่างล้างจาน" ("sink / wash basin").

## What this tool doesn't do

- ❌ Doesn't download videos from Udemy
- ❌ Doesn't transcribe audio from video — the lecture must already have English captions
- ❌ Doesn't work with courses you haven't bought

---

## Requirements

| Item | Required? |
|---|---|
| Python 3.10+ | Required |
| Google Chrome | Required (if using the extension) |
| **A translator** — pick one | Required |
| &nbsp;&nbsp;• [Antigravity CLI](https://antigravity.google) (`agy`) | No API key needed |
| &nbsp;&nbsp;• `ANTHROPIC_API_KEY` + `pip install -r requirements.txt` | Optional |
| PyMuPDF (`pip install pymupdf`) | Only if translating PDF files |

The core uses nothing but the Python standard library — no install needed if you don't touch PDFs.

---

## Main way to use it — Chrome extension

**[🚀 Simple install guide (start here)](INSTALL.md)** (Thai) · [Detailed guide](docs/install-extension.md) (Thai)

Quick summary, done once:

1. Double-click **`install.cmd`** — it installs all the Python packages for you
2. Open `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select the `extension` folder
3. Every time you study: double-click **`start-server.cmd`**, leave it running, then open the lecture — no need to press CC

The first time for each lecture takes 30 seconds to 2 minutes to translate. After that it appears instantly from the cache.

### Thai dubbing

Turn on the **dubbing** switch from the panel over the video; choose from 7 engines
— **[Full details at docs/voices.md](docs/voices.md)** (Thai)

| Engine | Free? | What you need to set up |
|---|---|---|
| **edge** — Microsoft Azure Neural | Unlimited | Just `pip install -r requirements.txt` **(recommended for non-GPU PCs)** |
| **windows** — Windows built-in voices | Unlimited | Nothing to set up, but can't be cached |
| **google** — Chirp 3 HD | 1 million characters/month | A Google Cloud account + service account JSON |
| **thonburian** — ThonburianTTS (megaF5) | Unlimited | **Colab A100** (`colab/hongrian_voice_a100.ipynb`) or local GPU + `flowtts` **(most natural Thai prosody + voice cloning)** |
| **openjai** — OpenJaiTTS (v1.0) | Unlimited | **Colab A100** or local GPU + `flowtts` (crisp narration + voice cloning) |
| **seamless** — Meta SeamlessM4T | Unlimited | **Colab A100** or local GPU + `transformers`, `torch`, `soundfile` (supports Instant mode) |
| **omnivoice** — OmniVoice Thai | Unlimited | **Colab A100** or local GPU + `pip install omnivoice soundfile` (supports voice cloning) |

`edge` and `windows` are **the exact same voice** (Niwat / Premwadee = Azure Neural).
The only difference is that `windows` generates the voice in the browser, so it can't be cached or pre-fetched.
If you're watching a long course, use `edge`.

`thonburian`, `openjai`, `omnivoice`, and `seamless` can run on a **Colab A100 GPU** via [`colab/hongrian_voice_a100.ipynb`](colab/hongrian_voice_a100.ipynb), keeping `agy` as the local subtitle translator while offloading Thai voice synthesis, zero-shot voice cloning (`UDTH_VOICE_REF`), and parallel batch prefetching to A100 (with automatic fallback to `edge` if Colab disconnects).

The list of engines isn't hard-coded into the extension — it's fetched from the server. Install an extra engine on the
Python side and it just shows up in the options.

While dubbing, you can adjust the instructor's volume and the dub's volume from the panel over the video or from the popup.
The voice stops and restarts to follow pausing, seeking, and changing lectures.

**The dub doesn't follow the subtitles line by line** — a subtitle cue is a display chunk
(three or four words, cut mid-sentence to fit the screen). Dubbing straight from that would sound choppy
and get cut off mid-word on every line, because a Thai sentence always takes longer to say than an English one.

So the system merges the cues back into full sentences first, then dubs sentence by sentence:

- **Never interrupts a sentence that's being spoken.** The next sentence always waits until it finishes.
- **Speeds up to fit the available time**, calculated from the time remaining until the next sentence —
  not just until the subtitle disappears (the instructor's breathing pause between sentences counts as usable time).
  The default cap is 1.6x, adjustable in the settings panel.
- **Preloads audio 4 sentences ahead** and decodes the MP3 in advance, so it never starts speaking late.

### Translation speed

The first time for each lecture, there's a real wait, because translation runs with an AI on your own machine, not sent to anyone's server.
What's been done to cut that wait:

- **Translates several chunks at once** — a long lecture is split into chunks that don't depend on each other,
  so 3 run in parallel (previously one at a time). Adjustable with `set UDTH_PARALLEL=5`,
  but each one is a separate `agy` process, so RAM use scales with the count.
- **Subtitles use medium effort**; documents and quizzes still use high.
  Subtitles are short spoken sentences — thinking harder doesn't improve them enough to be worth the extra time.
  (If you set `--effort low` yourself, the system won't override it.)
- **Translate section** — the most effective method; see below
- **Fast mode (`--engine claude` only)** — uses a smaller, faster model for subtitles

  ```cmd
  set UDTH_FAST=1
  ```

  Subtitles will use Haiku 4.5 ($1/$5 per million tokens); documents and quizzes still use Opus,
  because those two need careful reading and contain code and exam questions.
  You can change the model yourself with `set UDTH_FAST_MODEL=claude-sonnet-5`.

  This is the same trick paid tools use to feel fast — a smaller model, not magic.

> Paid tools that are faster than this usually send your text to the service provider's cloud for translation.
> This project chose to run everything locally instead — slower the first time, but no one sees what you're studying,
> there's no monthly fee, and however many times you rewatch, it never needs to translate again.

### Translate section ahead of time (no more waiting lecture by lecture)

Open any lecture in the Section you want to study → click the extension icon → **Translate this whole section ahead**

The extension gathers up every video and article in the Section and sends them to the server's queue to translate in one go.
By the time you reach the next lectures, the translation is already waiting in the cache — no more waiting.

- While translating, a status box in the **bottom-left corner** of the Udemy page shows how many lectures are left
- **You can change lectures or close the box** — the queue lives on the server, not on the web page
- The lecture you're currently watching always jumps the queue — it never waits for the background queue to finish first
- Lectures already translated are skipped, and lectures that already have human-translated Thai subtitles are skipped too
- Quizzes aren't included in this queue (some have up to 250 questions) — open the quiz page and it translates itself

> ⚠️ Every time you edit the extension's code, you need to refresh its card at `chrome://extensions`
> **and also press F5 on the Udemy page** — otherwise it will show "The extension was just updated".

---

## Check that the system is ready (automated tests)

```cmd
python -m unittest discover -s tests -v
node --test tests/
```

Tests the subtitle parser (SRT / VTT / Udemy's transcript panel), the subtitle file builder, the glossary, and the server (including security).
No internet connection needed, no `agy` used, and it never overwrites your glossary or cache.

### Local server security

The server only listens on `127.0.0.1` and **only accepts requests from this extension** (the Origin must start with
`chrome-extension://`), plus command-line tools like curl that send no Origin at all. A regular web page you have open
can't trigger a translation or generate audio (it gets a 403), and requests with a spoofed Host header are rejected too
(this guards against DNS rebinding). If you switch to calling it from some other tool that sends its own Origin, you'll need to edit `origin_allowed` in `udemy_th/server.py`.

### Tidy up the glossary

```cmd
python -m udemy_th glossary --tidy --json out\glossary-cards.json
```

Merges duplicates (`Array.from` and `Array.from()`, the various forms of `BOM`) and drops words that aren't programming terms
(like `speed`, `sign in`), always backing up the original file to `glossary/glossary.backup-<date>.json` first.
`--json` exports a file for making flashcards.

## Secondary way to use it — CLI

### Translate attachments

Download the attachment from Udemy as usual, then **drag the file onto `translate-docs.cmd`**

Or run it directly:

```bash
python -m udemy_th docs "C:\Downloads\slides.pdf"
python -m udemy_th docs "C:\Downloads\course-handouts"   # the whole folder
```

You get `.th.md` files in `out/docs/` — code files, zips, and images are skipped automatically.

### Generate `.srt` subtitle files to keep

Use this when you want a subtitle file to open in VLC, or a lecture summary to keep and read.

```bash
# Copy the transcript from Udemy (the Transcript button), then...
python -m udemy_th go                          # reads straight from the clipboard
python -m udemy_th go courses/my-course/       # or process a whole folder in one go
```

Or double-click **`translate-clipboard.cmd`** / **`translate-course.cmd`**

You get files in `out/<course>/<lecture>/`:

| File | What it's for |
|---|---|
| `<lecture>.dual.srt` | English + Thai subtitles **(recommended)** |
| `<lecture>.th.srt` | Thai subtitles only |
| `<lecture>.summary.md` | Lecture summary + code explanation + this lecture's terms |

---

## All commands

```bash
python -m udemy_th go [file|folder]     # does every step in one command (leave empty = clipboard)
python -m udemy_th docs <file|folder>   # translates attached document files
python -m udemy_th asr <audio/video>    # transcribes audio/video into a timestamped .srt via Whisper (A100 / local)
python -m udemy_th serve                # starts the server for the extension to use
python -m udemy_th glossary             # exports the glossary as Markdown
python -m udemy_th status               # shows how far each lecture's translation has gotten
```

Step by step (when you want to check the work partway through):

```bash
python -m udemy_th prepare <transcript file>
python -m udemy_th translate <working folder>
python -m udemy_th build <working folder>
```

Frequently used options:

| Option | Meaning |
|---|---|
| `--engine claude` | Uses the Claude API instead of Antigravity |
| `--effort low` | Translates faster; use for easy lectures |
| `build --bom` | Writes `.srt` as UTF-8 with BOM (fixes garbled Thai in VLC) |
| `go --force` | Retranslates, overwriting the existing output |
| `asr --lang en` | Specifies the spoken language when transcribing into `.srt` |

### Host Thai voice models and ASR on a Colab A100 (while keeping `agy` for translation)

1. Open [`colab/hongrian_voice_a100.ipynb`](colab/hongrian_voice_a100.ipynb) in Colab, pick an **A100** runtime and Run all
2. Paste the `UDTH_A100_URL` and `UDTH_A100_KEY` lines it prints at the end of `.env`
3. (Optional) To clone the instructor's voice, set `UDTH_VOICE_REF=C:\path\to\instructor.wav` in `.env`
4. Restart `start-server.cmd`; its window shows `เสียงพากย์ GPU : A100 Voice (...) — ถ้าหลุดใช้ Edge สำรองอัตโนมัติ`

The notebook hosts **ThonburianTTS (megaF5)**, **OpenJaiTTS (v1.0)**, **OmniVoice Thai**, **Meta SeamlessM4T-v2-large**, and **Typhoon Whisper Turbo / Whisper Large-v3 Turbo** in one server, and synthesizes translated sentences in parallel on A100 as each `agy` chunk completes.

### Translate with a large model on a Colab A100 (faster, no agy needed)

1. Open [`colab/hongrian_llm.ipynb`](colab/hongrian_llm.ipynb) in Colab, pick an **A100** runtime and Run all
2. Paste the three `UDTH_LLM_URL / UDTH_LLM_KEY / UDTH_LLM_MODEL` lines it prints at the end of `.env`
3. Restart `start-server.cmd`; its window shows a "ใช้ LLM ... ก่อน" (using the LLM first) line

The default is SCB 10X's Typhoon 2.1 (Gemma 3) 12B, trained for Thai.
On an A100 80GB you can switch to Typhoon 2 70B (FP8) in the notebook's first cell.

If Colab disconnects or its URL changes, translation falls back to `agy` chunk by chunk on its own.
(Colab allows serving like this only on paid plans with compute units left.)

### Translate with Claude Code instead (free, no API key needed)

```bash
python -m udemy_th prepare courses/my-course/05-closures.txt
```

Then tell Claude Code, inside this project:

> Read `work/my-course/05-closures/translate-request.md` and translate according to what the file specifies

Then `python -m udemy_th build work/my-course/05-closures`

---

## Highlight: the glossary keeps translations consistent across the whole course

Every time something is translated, the technical terms it finds are saved to `glossary/glossary.json`,
and the next lecture is fed this glossary back in before it's translated.

The result is that `closure` in lecture 40 is translated with the same word as in lecture 3, instead of a different word every lecture the way Google Translate would.
And as a bonus, you end up with a glossary you can review before an exam or interview.

```bash
python -m udemy_th glossary --course "JavaScript Masterclass"
# -> glossary/glossary.md, a table of every term with Thai explanations
```

The translation rule in place: **technical terms keep their English form** (`async`, `endpoint`, `middleware`),
with a Thai explanation added in parentheses the first time each one appears. **File names, class names, method names, and code
are never translated**, because you need to be able to type them exactly.

---

## How it works

```
Open a lecture on Udemy
   │
   ├─► Ask the Udemy API what kind of lecture this is, and what caption languages exist
   │      │
   │      ├─ Has human Thai captions ──► Tell the user to press CC, then stop
   │      │
   │      └─ None / only auto ──► Fetch the whole English WebVTT file
   │                                      │
   ▼                                      ▼
Show Thai subtitles over the video  ◄────  Your local server (127.0.0.1:8765)
      ▲                                   │
      └──── Disk cache ◄──── AI translates + uses the existing glossary
```

**Why ask the API instead of reading subtitles off the page:** testing against the real page found that Udemy
doesn't use the standard HTML5 TextTrack (`video.textTracks` is empty even while subtitles are showing on screen).
It loads the WebVTT file and draws it itself, and even clears the performance buffer afterward, so intercepting the file in transit isn't reliable.

**The cache key is the lecture id from the URL**, not the lecture title, because Udemy fills in the title on the page later.
Read it too early and you get one value; read it too late and you get another. Using the title as the key would mean retranslating every time you come back.

**The queue works one job at a time**, not all at once, because translating a whole Section means queuing a dozen-plus jobs in one go.
Running them in parallel would mean a dozen-plus `agy` processes fighting over the machine, and fighting to write to the same glossary file.
The lecture the user currently has open always gets its priority raised to jump ahead of the background queue.

**Gathering lectures happens on the web page; translating happens on the server**, because requesting the subtitle file from Udemy
needs the logged-in cookie, which only exists on the web page. Once a job is queued, the work lives on the server,
so changing lectures or closing the tab doesn't affect it.

**Whatever differs between sites is kept isolated in an adapter** (`extension/sites.js` for YouTube,
`extension/sites/udemy.js` for Udemy). Everything else — subtitles, dubbing, the menu, pausing the video —
has no idea which site it's running on at all. Adding a third site just means writing a new adapter.

**Subtitles and dubbing both read from one shared sentence timeline** (`core/timeline.js`), split from the original just once.
Each sentence has two levels of translation: `final` (AI) and `draft` (Seamless's quick translation); `final` always replaces `draft`.
The decision to pause or play the video lives in exactly one place: the state machine in `pipeline/session.js`.
Design details: [docs/design/dubbing-v2.md](docs/design/dubbing-v2.md) (Thai)

**YouTube requires a PoT (Proof of Origin Token) before it will send the subtitle file.** Hit the bare `baseUrl`
and you get HTTP 200 with **empty content**, not an error — which makes it look like the video has no subtitles when it actually does.

The token can't be computed yourself, but it's attached to the query string of every request the player itself fires.
`extension/pot-interceptor.js` therefore runs in the page's own world starting at `document_start`
and wraps `XMLHttpRequest.open` and `fetch` to forward the `pot` it sees, via a DOM event
(it never blocks or alters any request — it always calls the original with the original arguments).

If no token has been seen yet, it **presses YouTube's own CC button once** to force the player to
fire off a request, then presses it back to its original state. The URL finally used must have both `&pot=` and `&c=WEB`.

**The caption list is read directly from the player** via `chrome.scripting` running in the page's world,
calling `movie_player.getPlayerResponse()`, which always matches whatever clip is actually loaded —
better than digging `ytInitialPlayerResponse` out of HTML left over from the very first page load.

**Udemy marks parts of its player with `data-purpose`**, e.g. `[data-purpose="video-control-bar"]`.
Never rely on class names — they carry a per-build hash and change every time.

---

## Folder structure

```
udemy_th/    Python source code
extension/   Chrome extension
  sites.js, sites/   per-site adapters (YouTube, Udemy)
  core/              timeline (sentences) · settings · api (talks to the server) · i18n (interface language, Thai/English)
  pipeline/          session (pause/play the video) · dubber (dub timing) · voices (generates audio)
  ui/                overlay (subtitles) · menu (the button on the player) · gate (the waiting box)
  modes/             quiz / assignment / article / Udemy's translate-a-whole-section
  main.js            wires everything together
docs/        install guides
courses/     original transcripts you paste in
work/        in-progress files
out/         results (.srt + summaries + translated documents)
cache/       translations the extension keeps, so rewatching never retranslates
glossary/    all accumulated glossary terms
```

The 5 folders at the bottom are excluded via `.gitignore` — see the next section

### Something to know before editing `.cmd` files

Every `.cmd` file **must be pure ASCII — no Thai text at all**, not even in a `REM` line.

cmd.exe misreads a batch file's position when it contains non-ASCII bytes while the console
is on code page 65001 (UTF-8). The result is it runs a "fragment" of the next line as a command
and produces a weird error like this:

```
'emy_th' is not recognized as an internal or external command
```

Any Thai text the user needs to see should be printed from the Python side instead (Python handles UTF-8
correctly). The `.cmd` files already set `PYTHONIOENCODING=utf-8` for this.

---

## A note on copyright

This tool processes the content of courses **you've already bought**, on your own machine, so you can understand
lectures you've already paid for. Everything stays on your machine — it's never sent out or published anywhere.

**What you shouldn't do:** distribute the subtitle files, lecture summaries, or translated quiz answers to other people,
because the lecture content is the instructor's copyright, not yours.

The project's `.gitignore` already keeps the `cache/`, `out/`, `work/`, `courses/`, and `glossary/` folders
from being committed. But if you move files somewhere else, check `git status` before every commit.

---

## License

MIT — see the [LICENSE](LICENSE) file

The license covers only the code in this project — not the course content you process with it.
