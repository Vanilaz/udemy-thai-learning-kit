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

test('a seek into a sentence already under way waits for the next one instead of saying the past', async () => {
  const {video, voice} = setup();
  video.currentTime = 7.5; video.emit('seeking'); // "Second sentence" began at 5
  await video.at(7.5);
  assert.deepEqual(voice.said, [], 'nothing stale is said');
  await video.at(10);
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 3']);
});

test('a seek to just after a sentence began still says it', async () => {
  const {video, voice} = setup();
  video.currentTime = 5.8; video.emit('seeking');
  await video.at(5.8);
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 2']);
});

test('the instructor is heard wherever the dub has nothing to say', async () => {
  let now = 0;
  const timeline = createTimeline(cues, {lang: 'EN'});
  timeline.applyTranslation(translated(1)); // only the first sentence has Thai
  const video = fakeVideo(), voice = fakeVoice();
  createDubber({video, timeline, voice, now: () => now, settings: () => ({on: true, start: 'accurate', volume: 1, sourceVolume: 0, maxRate: 1.6})});
  await video.at(0);
  assert.equal(video.volume, 0, 'down while the line is said');
  await voice.finish();
  now = 500; await video.at(4.5);
  assert.equal(video.volume, 0, 'still down in the short gap after a line');
  now = 5000; await video.at(6);
  assert.equal(video.volume, 1, 'back up where there is no Thai to say');
});

test('after a seek, the line due there can be readied before the video moves on', async () => {
  const pending = {};
  const voice = fakeVoice({prepareDelay: w => new Promise(r => (pending[w.text] = r))});
  const {dubber} = setup({voice});
  let ready = false;
  dubber.prepareAt(9.6).then(() => (ready = true)); // "Third sentence" starts at 10
  await flush();
  assert.equal(ready, false);
  pending['ประโยคที่ 3'](); await flush(); await flush();
  assert.equal(ready, true);
  assert.equal(dubber.prepareAt(-10), null, 'nothing due soon: nothing to wait for');
});

test('while a line\'s audio is still on its way, the instructor is heard, not silence', async () => {
  const pending = {};
  const voice = fakeVoice({prepareDelay: w => new Promise(r => (pending[w.text] = r))});
  const {video} = setup({voice});
  await video.at(0);
  assert.equal(video.volume, 1, 'nothing is being said yet');
  pending['ประโยคที่ 1'](); await flush(); await flush();
  assert.equal(video.volume, 0.2, 'down once the Thai starts');
});

test('right after a seek the instructor is heard until the dub has something to say', async () => {
  const {video, voice} = setup();
  await video.at(0);
  assert.equal(video.volume, 0.2);
  video.currentTime = 7.5; video.emit('seeking');
  await video.at(7.5);
  assert.equal(video.volume, 1);
  assert.equal(voice.said.length, 1);
});

test('after a seek, a line some seconds away is fetched at once, without waiting on it', async () => {
  const {dubber, voice} = setup();
  assert.equal(dubber.prepareAt(6.8), null, 'the next line (at 10) is too far off to hold the video for');
  await flush();
  assert.ok(voice.prepared.includes('ประโยคที่ 3'), 'but its audio is already on the way');
});

test('a Thai line that ends early keeps the instructor down until the next sentence', async () => {
  const {video, voice} = setup();
  await video.at(0);
  await voice.finish(); // the Thai was shorter than the instructor's sentence
  await video.at(3);
  assert.equal(video.volume, 0.2, 'no English between the end of the Thai and the next line');
  await video.at(4.9);
  assert.equal(video.volume, 0.2);
});

test('resuming after a pause says the interrupted sentence again, not skipping it', async () => {
  const {video, voice} = setup();
  await video.at(0); await voice.finish();
  await video.at(5);
  video.currentTime = 8; video.paused = true; video.emit('pause');
  video.paused = false; video.emit('play'); await flush();
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 1', 'ประโยคที่ 2', 'ประโยคที่ 2']);
});

test('a seek well into a sentence the dub can say points back to where it starts', async () => {
  const {dubber} = setup({translatedCount: 2});
  assert.equal(dubber.lineStartAt(7.5), 5, 'well into the second sentence');
  assert.equal(dubber.lineStartAt(5.8), null, 'barely begun: nothing to move');
  assert.equal(dubber.lineStartAt(12), null, 'no Thai for the third sentence: nothing to gain');
});

test('a short Thai line is slowed a little to last while the instructor speaks, never much', async () => {
  const slow = createTimeline([{start: 0, end: 4.4, text: 'A long English sentence.'}, {start: 6, end: 8, text: 'Next.'}], {lang: 'EN'});
  slow.applyTranslation([{th: 'ก'}, {th: 'ข'}]);
  const video = fakeVideo(), voice = fakeVoice(); // every clip is 4s long
  createDubber({video, timeline: slow, voice, settings: () => ({on: true, start: 'accurate', volume: 1, sourceVolume: 0.2, maxRate: 1.6})});
  await video.at(0);
  assert.equal(voice.said[0].rate.toFixed(3), (4 / 4.4).toFixed(3), '4s of Thai fills the 4.4s the instructor speaks');

  const long = createTimeline([{start: 0, end: 10, text: 'A very long English sentence.'}], {lang: 'EN'});
  long.applyTranslation([{th: 'ก'}]);
  const video2 = fakeVideo(), voice2 = fakeVoice();
  createDubber({video: video2, timeline: long, voice: voice2, settings: () => ({on: true, start: 'accurate', volume: 1, sourceVolume: 0.2, maxRate: 1.6})});
  await video2.at(0);
  assert.equal(voice2.said[0].rate, 0.85, 'but never slower than 0.85x');
});

test('while the player is loading, the dub waits too and then says the line in step with the picture', async () => {
  const {video, voice} = setup();
  video.currentTime = 5; video.emit('seeking');
  video.emit('waiting'); // the player has no video here yet
  await video.at(5);
  assert.deepEqual(voice.said, [], 'not ahead of a picture that is not moving');
  video.emit('playing'); await flush();
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 2']);
});

test('a stall mid-line stops the voice and says the line again once the video moves', async () => {
  const {video, voice} = setup();
  await video.at(0); await voice.finish();
  await video.at(5);
  video.emit('waiting');
  assert.equal(voice.active.stopped, true);
  video.emit('playing'); await flush();
  assert.deepEqual(voice.said.map(s => s.text), ['ประโยคที่ 1', 'ประโยคที่ 2', 'ประโยคที่ 2']);
});

test('the sentence due now is marked urgent, the ones fetched ahead are not', async () => {
  const urgency = {};
  const voice = fakeVoice();
  const prepare = voice.prepare;
  voice.prepare = (words, opts) => { urgency[words.text] = Boolean(opts && opts.urgent); return prepare(words); };
  const {video} = setup({voice});
  await video.at(0);
  assert.deepEqual(urgency, {'ประโยคที่ 1': true, 'ประโยคที่ 2': false, 'ประโยคที่ 3': false});
});
