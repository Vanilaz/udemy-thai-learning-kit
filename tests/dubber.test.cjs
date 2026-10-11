// The dubber decides what to say and when, against a video clock.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTimeline} = require('../extension/core/timeline.js');
const {createDubber} = require('../extension/pipeline/dubber.js');

const flush = () => new Promise(setImmediate);

function fakeVideo() {
  const listeners = {};
  return {
    currentTime: 0, paused: false, ended: false, playbackRate: 1, volume: 1,
    addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
    removeEventListener: (t, fn) => (listeners[t] = (listeners[t] || []).filter(f => f !== fn)),
    emit(type) { (listeners[type] || []).forEach(fn => fn()); },
    async at(time) { this.currentTime = time; this.emit('timeupdate'); await flush(); },
  };
}

// A voice whose clips finish when the test says so.
function fakeVoice({canTranslate = false, spokenText = null, prepareDelay = null} = {}) {
  const voice = {
    canTranslate, said: [], prepared: [], active: null, gates: new Map(),
    async prepare(words) {
      voice.prepared.push(words.text);
      if (prepareDelay) await prepareDelay(words);
      return {spokenText: words.lang ? spokenText : null};
    },
    speak(words, {volume, fitRate}) {
      let finish;
      const done = new Promise(r => (finish = r));
      const rate = fitRate(4);
      voice.said.push({text: words.text, lang: words.lang, volume, rate});
      voice.active = {finish, stopped: false};
      const handle = {done, stop() { voice.active.stopped = true; finish(); }};
      return handle;
    },
    async finish() { voice.active && voice.active.finish(); await flush(); },
  };
  return voice;
}

const cues = [
  {start: 0, end: 4, text: 'First sentence.'},
  {start: 5, end: 9, text: 'Second sentence.'},
  {start: 10, end: 14, text: 'Third sentence.'},
];
const translated = (n) => cues.map((c, i) => ({...c, en: c.text, th: i < n ? `ประโยคที่ ${i + 1}` : ''}));

function setup({settings = {}, voice = fakeVoice(), translatedCount = 3, lang = 'ES'} = {}) {
  const timeline = createTimeline(cues, {lang});
  timeline.applyTranslation(translated(translatedCount));
  const video = fakeVideo();
  const dub = {on: true, start: 'accurate', volume: 0.9, sourceVolume: 0.2, maxRate: 1.6, ...settings};
  const drafts = [];
  const dubber = createDubber({video, timeline, voice, settings: () => dub, onDraft: id => drafts.push(id)});
  return {timeline, video, voice, dubber, dub, drafts};
}

test('each sentence is spoken in Thai when its time comes, one at a time', async () => {
  const {video, voice} = setup();
  await video.at(0);
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 1']);
  await video.at(2);
  assert.equal(voice.said.length, 1, 'no overlap while the first is still speaking');
  await voice.finish();
  await video.at(5);
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 1', 'ประโยคที่ 2']);
});

test('accurate mode stays silent where the AI translation has not arrived', async () => {
  const {video, voice} = setup({translatedCount: 1, voice: fakeVoice({canTranslate: true})});
  await video.at(0); await voice.finish();
  await video.at(5);
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 1']);
});

test('instant mode speaks untranslated sentences from the original and records the draft', async () => {
  const voice = fakeVoice({canTranslate: true, spokenText: 'ร่าง'});
  const {video, timeline, drafts} = setup({translatedCount: 1, voice, settings: {start: 'instant'}});
  await video.at(0); await voice.finish();
  await video.at(5);
  assert.deepEqual(voice.said.at(-1), {text: 'Second sentence.', lang: 'es', volume: 0.9, rate: 1});
  assert.equal(timeline.sentences[1].draft, 'ร่าง');
  // Prepared ahead, so the next line's provisional subtitle is ready before it starts.
  assert.deepEqual(drafts, [timeline.sentences[1].id, timeline.sentences[2].id]);
  assert.equal(timeline.sentences[0].draft, null, 'a translated line never gets a draft');
});

test('instant mode needs a voice that can translate', async () => {
  const {video, voice} = setup({translatedCount: 0, settings: {start: 'instant'}});
  await video.at(0);
  assert.deepEqual(voice.said, []);
});

test('upcoming sentences are prepared ahead of the playhead', async () => {
  const {video, voice} = setup();
  await video.at(0);
  assert.deepEqual(voice.prepared.slice(0, 3), ['ประโยคที่ 1', 'ประโยคที่ 2', 'ประโยคที่ 3']);
});

test('seeking stops the current line and picks up at the new position', async () => {
  const {video, voice} = setup();
  await video.at(0);
  video.currentTime = 10.5; video.emit('seeking'); await flush();
  assert.equal(voice.active.stopped, true);
  await video.at(10.5);
  assert.equal(voice.said.at(-1).text, 'ประโยคที่ 3');
});

test('a line that is ready too late is skipped rather than spoken over the next', async () => {
  const pending = {};
  const voice = fakeVoice({prepareDelay: w => new Promise(r => (pending[w.text] = r))});
  const {video} = setup({voice});
  await video.at(0);
  video.currentTime = 7.0; // the first line ended at 4; its audio only now arrives
  pending['ประโยคที่ 1'](); await flush();
  assert.deepEqual(voice.said, [], 'the late first line is dropped');
  pending['ประโยคที่ 2']();
  await video.at(7.1);
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 2'], 'and the dub carries on with the current one');
});

test('pausing the video stops the voice', async () => {
  const {video, voice} = setup();
  await video.at(0);
  video.paused = true; video.emit('pause'); await flush();
  assert.equal(voice.active.stopped, true);
});

test('the instructor is turned down while dubbing and restored when it is switched off', async () => {
  const {video, dubber, dub} = setup();
  await video.at(0);
  assert.equal(video.volume, 0.2);
  dub.on = false; dubber.refresh();
  assert.equal(video.volume, 1);
});

test('a long line is sped up to fit its slot, but never past the cap', async () => {
  const cramped = createTimeline([{start: 0, end: 1, text: 'Short slot.'}, {start: 1.5, end: 3, text: 'Next.'}], {lang: 'EN'});
  cramped.applyTranslation([{th: 'ก'}, {th: 'ข'}]);
  const video = fakeVideo(), voice = fakeVoice();
  createDubber({video, timeline: cramped, voice, settings: () => ({on: true, start: 'accurate', volume: 1, sourceVolume: 0.2, maxRate: 1.6})});
  await video.at(0);
  assert.equal(voice.said[0].rate, 1.6, '4s of audio into a 1.5s slot is capped at 1.6x');
});

test('a stuck line is abandoned after its deadline so the rest are not lost', async () => {
  let now = 0;
  const timeline = createTimeline(cues, {lang: 'EN'});
  timeline.applyTranslation(translated(3));
  const video = fakeVideo(), voice = fakeVoice();
  createDubber({video, timeline, voice, now: () => now, settings: () => ({on: true, start: 'accurate', volume: 1, sourceVolume: 0.2, maxRate: 1.6})});
  await video.at(0);
  now = 60_000; // the first clip never reported its end
  await video.at(5);
  assert.equal(voice.said.at(-1).text, 'ประโยคที่ 2');
});
