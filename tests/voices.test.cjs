// The server voice: one request per distinct line, bounded memory.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createServerVoice} = require('../extension/pipeline/voices.js');

const flush = () => new Promise(setImmediate);

function fakeAudio() {
  const el = {listeners: {}, played: 0, paused: 0, readyState: 1, duration: 3, currentTime: 9,
    load() {}, addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    play() { el.played += 1; return Promise.resolve(); }, pause() { el.paused += 1; }};
  return el;
}

function setup() {
  const requests = [], revoked = [];
  let n = 0;
  const api = {speak: async (req) => { requests.push(req); return {audio: {base64: 'x', type: 'audio/wav'}, spokenText: req.lang ? 'ไทย' : null}; }};
  const voice = createServerVoice({api, voiceId: 'seamless:th', translates: true, createAudio: fakeAudio,
    toUrl: () => `blob:${++n}`, revoke: (u) => revoked.push(u)});
  return {voice, requests, revoked};
}

test('the same line is requested from the server once', async () => {
  const {voice, requests} = setup();
  await Promise.all([voice.prepare({text: 'สวัสดี', lang: null}), voice.prepare({text: 'สวัสดี', lang: null})]);
  await voice.prepare({text: 'Hola', lang: 'es'});
  assert.deepEqual(requests, [
    {voice: 'seamless:th', text: 'สวัสดี', lang: null, priority: 'ahead'},
    {voice: 'seamless:th', text: 'Hola', lang: 'es', priority: 'ahead'},
  ]);
});

test('the line due now is asked for as such, so it jumps the server queue', async () => {
  const {voice, requests} = setup();
  await voice.prepare({text: 'ตอนนี้', lang: null}, {urgent: true});
  assert.equal(requests[0].priority, 'now');
});

test('a translated line reports the Thai it spoke', async () => {
  const {voice} = setup();
  assert.equal((await voice.prepare({text: 'Hola', lang: 'es'})).spokenText, 'ไทย');
});

test('old clips are released so a long course does not hold every line in memory', async () => {
  const {voice, revoked} = setup();
  for (let i = 0; i < 45; i += 1) await voice.prepare({text: `line ${i}`, lang: null});
  await flush();
  assert.deepEqual(revoked, ['blob:1', 'blob:2', 'blob:3', 'blob:4', 'blob:5']);
});

test('speaking plays from the start at the fitted rate and the given volume', async () => {
  const {voice} = setup();
  const clip = await voice.prepare({text: 'สวัสดี', lang: null});
  const handle = voice.speak({text: 'สวัสดี', lang: null}, {volume: 0.7, fitRate: (s) => (s === 3 ? 1.25 : 9)});
  await flush();
  assert.equal(clip.element.played, 1);
  assert.equal(clip.element.currentTime, 0);
  assert.equal(clip.element.volume, 0.7);
  assert.equal(clip.element.playbackRate, 1.25);
  clip.element.onended();
  await handle.done;
});

test('stopping pauses the clip and settles the line', async () => {
  const {voice} = setup();
  const clip = await voice.prepare({text: 'สวัสดี', lang: null});
  const handle = voice.speak({text: 'สวัสดี', lang: null}, {volume: 1, fitRate: () => 1});
  await flush();
  handle.stop();
  await handle.done;
  assert.equal(clip.element.paused, 1);
});

test('automatic voice stays inside the selected engine', () => {
  const {resolveVoiceId} = require('../extension/pipeline/voices.js');
  const seamless = {voices: [{id: 'seamless:th'}]};
  const omni = {voices: [{id: 'omnivoice:male'}, {id: 'omnivoice:female'}]};
  assert.equal(resolveVoiceId({voice: ''}, seamless), 'seamless:th');
  assert.equal(resolveVoiceId({voice: 'th-TH-NiwatNeural'}, seamless), 'seamless:th', 'a voice saved from Edge is ignored');
  assert.equal(resolveVoiceId({voice: 'omnivoice:female'}, omni), 'omnivoice:female');
  assert.equal(resolveVoiceId({voice: ''}, undefined), 'th-TH-NiwatNeural', 'server down: a safe default');
});
