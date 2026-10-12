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
    seek(time) { this.currentTime = time; (listeners.seeked || []).forEach(fn => fn()); },
  };
}

// 200 seconds of captions, one sentence every 10s.
const cues = Array.from({length: 20}, (_, i) => ({start: i * 10, end: i * 10 + 8, text: `Sentence ${i}.`}));
const rows = (n) => cues.map((c, i) => ({...c, en: c.text, th: i < n ? `ประโยค ${i}` : ''}));

// A translation the test releases chunk by chunk.
function controllableApi({engines = [], warmup = () => ({state: 'none'})} = {}) {
  let push, finish, fail;
  const focused = [];
  const api = {
    focus: async (job, time) => { focused.push([job, time]); return {ok: true}; },
    engines: async () => engines,
    warmup: async (name) => warmup(name),
    translate: (payload, {onPartial, onJob, isCurrent}) => new Promise((resolve, reject) => {
      if (onJob) onJob('job1');
      push = (r) => onPartial(r);
      finish = (r) => (isCurrent() ? resolve(r) : reject(Object.assign(new Error('stale'), {stale: true})));
      fail = reject;
    }),
  };
  return {api, focused, push: r => push(r), finish: r => finish(r), fail: e => fail(e)};
}

const silentVoice = () => ({canTranslate: false, prepare: async () => ({}), speak: () => ({done: new Promise(() => {}), stop() {}})});
const translatingVoice = () => ({...silentVoice(), canTranslate: true});

function setup({dub = {}, transcript = {ok: true, cues, sourceLang: 'EN'}, api, voice = silentVoice(), sleep = () => flush(1)} = {}) {
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
    sleep,
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

// ---------------------------------------------------------------- seeking

async function playingAccurate() {
  const t = controllableApi();
  const ctx = setup({api: t.api});
  ctx.session.start();
  await flush();
  t.push(rows(10)); await flush(); // 0-98s translated, the lecture plays
  assert.equal(ctx.last().phase, 'playing');
  return {t, ...ctx};
}

test('accurate: a seek past the translation holds again and asks for that stretch first', async () => {
  const {t, video, last} = await playingAccurate();
  video.seek(150);
  await flush();
  assert.deepEqual(t.focused, [['job1', 150]], 'the server is told where the viewer went');
  assert.equal(last().phase, 'waiting');
  assert.equal(last().waitingFor.translation.seeked, true, 'the gate can say why');
  assert.ok(video.paused, 'no English-only stretch with a silent dub');
  t.push(rows(20)); await flush();
  assert.equal(last().phase, 'playing');
  assert.equal(last().waitingFor, undefined);
  assert.equal(video.plays, 2, 'resumes on its own, as at the start');
});

test('accurate: a seek within the translated part plays on', async () => {
  const {t, video, last} = await playingAccurate();
  video.seek(5);
  await flush();
  assert.equal(last().phase, 'playing');
  assert.deepEqual(t.focused, [['job1', 5]]);
});

test('accurate: after skipping the wait once, seeks never hold again', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api});
  session.start();
  await flush();
  session.skipWait(); await flush();
  video.seek(150); await flush();
  assert.equal(last().phase, 'playing');
  assert.deepEqual(t.focused, [['job1', 150]], 'the jump is still translated first');
});

test('instant: a seek is translated first but never holds the video', async () => {
  const t = controllableApi();
  const {session, video, last} = setup({api: t.api, dub: {on: true, start: 'instant', engine: 'seamless'}, voice: translatingVoice()});
  session.start();
  await flush();
  video.seek(150); await flush();
  assert.equal(last().phase, 'playing');
  assert.equal(video.paused, false);
  assert.deepEqual(t.focused, [['job1', 150]]);
});

test('once the translation is finished, seeking is left to the player', async () => {
  const {t, video, last} = await playingAccurate();
  t.finish(rows(20)); await flush();
  video.seek(150); await flush();
  assert.equal(last().phase, 'playing');
  assert.deepEqual(t.focused, []);
});

test('a lecture opened mid-way is translated from where it starts', async () => {
  const t = controllableApi();
  const {session, video} = setup({api: t.api});
  video.currentTime = 75;
  session.start();
  await flush();
  assert.deepEqual(t.focused, [['job1', 75]]);
});

// ------------------------------------------------- waiting for the dub's audio

// Timers the test fires by duration, and a voice whose audio arrives on cue.
function manualClock() {
  const timers = [];
  return {
    sleep: (ms) => new Promise((resolve) => timers.push({ms, resolve})),
    async fire(ms) { timers.filter((t) => t.ms === ms).forEach((t) => t.resolve()); await flush(); },
  };
}
function slowVoice() {
  const pending = new Map();
  return {
    pending,
    canTranslate: false,
    prepare: (words) => new Promise((resolve) => pending.set(words.text, resolve)),
    speak: () => ({done: new Promise(() => {}), stop() {}}),
    async arrive(text) { pending.get(text)({}); await flush(); },
  };
}

async function dubbedAndPlaying({voice = slowVoice()} = {}) {
  const t = controllableApi();
  const clock = manualClock();
  const ctx = setup({api: t.api, voice, sleep: clock.sleep, dub: {on: true, start: 'accurate', engine: 'edge'}});
  ctx.session.start();
  await flush();
  t.push(rows(20)); await flush(); // the whole lecture is translated
  assert.equal(ctx.last().phase, 'playing');
  return {t, clock, voice, ...ctx};
}

test('after a seek, the video waits for the dub audio there, then plays on by itself', async () => {
  const {clock, voice, video, last} = await dubbedAndPlaying();
  video.seek(120.5); // sentence 12 starts at 120
  await clock.fire(150);
  assert.equal(last().phase, 'waiting');
  assert.deepEqual(Object.keys(last().waitingFor), ['speech']);
  assert.ok(video.paused, 'not playing on in silence');
  await voice.arrive('ประโยค 12');
  assert.equal(last().phase, 'playing');
  assert.equal(video.paused, false, 'resumes on its own');
});

test('audio that is ready at once does not flash the waiting card', async () => {
  const {clock, voice, video, states} = await dubbedAndPlaying();
  const before = states.length;
  video.seek(120.5);
  await voice.arrive('ประโยค 12');
  await clock.fire(150);
  assert.equal(states.slice(before).some((s) => s.phase === 'waiting'), false);
});

test('a dub that never answers holds the video only for so long', async () => {
  const {clock, video, last} = await dubbedAndPlaying();
  video.seek(120.5);
  await clock.fire(150);
  assert.equal(last().phase, 'waiting');
  await clock.fire(8000);
  assert.equal(last().phase, 'playing');
  assert.equal(video.paused, false);
});

test('seeking a paused video, or after skipping the wait, never holds for the dub', async () => {
  const {clock, video, session, last} = await dubbedAndPlaying();
  video.paused = true;
  video.seek(120.5);
  await clock.fire(150);
  assert.equal(last().phase, 'playing');
  video.paused = false;
  session.skipWait();
  video.seek(150.5);
  await clock.fire(150);
  assert.equal(last().phase, 'playing');
});

test('a seek into the middle of a sentence starts the video at that sentence, then waits for its audio', async () => {
  const {clock, voice, video, last} = await dubbedAndPlaying();
  video.seek(125); // sentence 12 runs 120-128
  assert.equal(video.currentTime, 120, 'moved back to where the sentence starts');
  video.seek(120); // the browser reports the seek we caused
  assert.equal(video.currentTime, 120, 'and only once');
  await clock.fire(150);
  assert.deepEqual(Object.keys(last().waitingFor), ['speech']);
  await voice.arrive('ประโยค 12');
  assert.equal(last().phase, 'playing');
});

test('with the dub off, a seek lands exactly where the viewer chose', async () => {
  const t = controllableApi();
  const {session, video} = setup({api: t.api});
  session.start(); await flush();
  t.push(rows(20)); await flush();
  video.seek(125);
  assert.equal(video.currentTime, 125);
});
