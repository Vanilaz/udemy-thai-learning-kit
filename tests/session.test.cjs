// A lecture session: from captions to a playing, subtitled, dubbed video.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSession} = require('../extension/pipeline/session.js');

const flush = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise(setImmediate); };

function fakeVideo() {
  const listeners = {};
  return {
    currentTime: 0, paused: false, ended: false, playbackRate: 1, volume: 1, plays: 0, pauses: 0,
    addEventListener: (t, fn) => (listeners[t] = listeners[t] || []).push(fn),
    removeEventListener: (t, fn) => (listeners[t] = (listeners[t] || []).filter(f => f !== fn)),
    pause() { this.paused = true; this.pauses += 1; },
    play() { this.paused = false; this.plays += 1; (listeners.play || []).forEach(fn => fn()); return Promise.resolve(); },
  };
}

// 200 seconds of captions, one sentence every 10s.
const cues = Array.from({length: 20}, (_, i) => ({start: i * 10, end: i * 10 + 8, text: `Sentence ${i}.`}));
const rows = (n) => cues.map((c, i) => ({...c, en: c.text, th: i < n ? `ประโยค ${i}` : ''}));

// A translation the test releases chunk by chunk.
function controllableApi({engines = [], warmup = () => ({state: 'none'})} = {}) {
  let push, finish, fail;
  const api = {
    engines: async () => engines,
    warmup: async (name) => warmup(name),
    translate: (payload, {onPartial, isCurrent}) => new Promise((resolve, reject) => {
      push = (r) => onPartial(r);
      finish = (r) => (isCurrent() ? resolve(r) : reject(Object.assign(new Error('stale'), {stale: true})));
      fail = reject;
    }),
  };
  return {api, push: r => push(r), finish: r => finish(r), fail: e => fail(e)};
}

const silentVoice = () => ({canTranslate: false, prepare: async () => ({}), speak: () => ({done: new Promise(() => {}), stop() {}})});
const translatingVoice = () => ({...silentVoice(), canTranslate: true});

function setup({dub = {}, transcript = {ok: true, cues, sourceLang: 'EN'}, api, voice = silentVoice()} = {}) {
  const video = fakeVideo();
  const states = [];
  const settings = {v: 2, subtitles: 'both', textSize: 'm',
    dub: {on: false, engine: 'edge', voice: '', start: 'instant', volume: 1, sourceVolume: 0.15, maxRate: 1.6, ...dub}};
  const session = createSession({
    site: {title: () => 'Lesson', cacheScope: () => 'course', cacheId: () => 'lec1', transcript: async () => transcript},
    video,
    api,
    settings: {get: () => settings, subscribe: () => () => {}},
    makeVoice: () => voice,
    onState: (s) => states.push(s),
    pollMs: 1,
    sleep: () => flush(1),
  });
  return {session, video, states, settings, last: () => states.at(-1)};
}

test('accurate start: the video is held until 90 seconds ahead are translated', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api});
  session.start();
  await flush();
  assert.equal(last().phase, 'waiting');
  assert.deepEqual(Object.keys(last().waitingFor), ['translation']);
  assert.ok(video.paused, 'held while waiting');
  t.push(rows(5)); await flush();
  assert.equal(last().phase, 'waiting', '48s of runway is not enough');
  assert.equal(last().waitingFor.translation.readySeconds, 48);
  t.push(rows(10)); await flush();
  assert.equal(last().phase, 'playing');
  assert.equal(video.plays, 1, 'the lecture resumes on its own');
});

test('instant start with a voice that translates plays without waiting for the AI', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api, dub: {on: true, start: 'instant', engine: 'seamless'}, voice: translatingVoice()});
  session.start();
  await flush();
  assert.equal(last().phase, 'playing');
  assert.equal(video.pauses, 0);
  assert.deepEqual(last().translating, {done: 0, total: 0});
});

test('instant start still waits for a voice model that is loading', async () => {
  let state = 'loading';
  const t = controllableApi({warmup: () => ({state})});
  const {session, last} = setup({api: t.api, dub: {on: true, start: 'instant', engine: 'seamless'}, voice: translatingVoice()});
  session.start();
  await flush();
  assert.deepEqual(Object.keys(last().waitingFor), ['voice']);
  state = 'loaded';
  await flush(10);
  assert.equal(last().phase, 'playing');
});

test('a voice that cannot translate falls back to waiting for the AI, even in instant mode', async () => {
  const t = controllableApi();
  const {session, last} = setup({api: t.api, dub: {on: true, start: 'instant'}});
  session.start();
  await flush();
  assert.deepEqual(Object.keys(last().waitingFor), ['translation']);
});

test('a lecture with human Thai captions is left alone', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api, transcript: {ok: false, code: 'native-thai'}});
  session.start();
  await flush();
  assert.deepEqual(last(), {phase: 'unavailable', reason: 'native-thai'});
  assert.equal(video.pauses, 0);
});

test('a failed translation before release is an error that releases the video', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api});
  session.start();
  await flush();
  t.fail(new Error('agy ล้มเหลว')); await flush();
  assert.equal(last().phase, 'error');
  assert.match(last().message, /agy ล้มเหลว/);
  assert.equal(video.paused, false);
});

test('a translation that fails at once is reported, not overwritten by the voice check', async () => {
  const api = {engines: async () => [], warmup: async () => ({state: 'none'}), translate: async () => { throw new Error('เซิร์ฟเวอร์ปฏิเสธ'); }};
  const {session, last} = setup({api, dub: {on: true, engine: 'edge'}});
  session.start();
  await flush();
  assert.equal(last().phase, 'error');
  assert.match(last().message, /เซิร์ฟเวอร์ปฏิเสธ/);
});

test('a failed translation while already playing keeps the lecture going', async () => {
  const t = controllableApi();
  const {session, last} = setup({api: t.api, dub: {on: true, start: 'instant', engine: 'seamless'}, voice: translatingVoice()});
  session.start();
  await flush();
  t.fail(new Error('agy ล้มเหลว')); await flush();
  assert.equal(last().phase, 'playing');
  assert.match(last().notice, /agy ล้มเหลว/);
});

test('skipping the wait releases the video and the translation carries on', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api});
  session.start();
  await flush();
  session.skipWait();
  assert.equal(last().phase, 'playing');
  assert.equal(video.paused, false);
  t.finish(rows(20)); await flush();
  assert.equal(last().translating, null);
});

test('subtitles show the translation as it arrives', async () => {
  const t = controllableApi();
  const {session} = setup({api: t.api});
  session.start();
  await flush();
  t.push(rows(10)); await flush();
  assert.equal(session.captionAt(1).text, 'ประโยค 0');
  assert.equal(session.captionAt(101).text, 'Sentence 10.', 'untranslated lines show the original');
});

test('a disposed session ignores late results', async () => {
  const t = controllableApi();
  const {session, states} = setup({api: t.api});
  session.start();
  await flush();
  const count = states.length;
  session.dispose();
  t.push(rows(20)); await flush();
  assert.equal(states.length, count);
});
