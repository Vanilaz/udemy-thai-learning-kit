// The page's client for the local server, tested against a scripted transport.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createApi, ApiError, Stale} = require('../extension/core/api.js');

// Answers requests from a table: "METHOD path" -> response or function.
function transport(routes) {
  const calls = [];
  const send = async (msg) => {
    calls.push(`${msg.method} ${msg.path}`);
    const route = routes[`${msg.method} ${msg.path}`];
    if (route === undefined) return {ok: false, status: 404, error: 'not found'};
    return typeof route === 'function' ? route(msg) : route;
  };
  return {send, calls};
}
const noWait = () => Promise.resolve();

test('a cached lecture comes back without polling', async () => {
  const {send, calls} = transport({'POST /translate': {ok: true, data: {status: 'done', cues: [{th: 'ก'}]}}});
  const rows = await createApi(send, {sleep: noWait}).translate({cues: []});
  assert.deepEqual(rows, [{th: 'ก'}]);
  assert.deepEqual(calls, ['POST /translate']);
});

test('a running job streams partial rows, then the final result', async () => {
  const polls = [
    {ok: true, data: {status: 'running', progress: 1, chunks: 3, cues: [{th: 'ก'}, {th: ''}]}},
    {ok: true, data: {status: 'done', cues: [{th: 'ก'}, {th: 'ข'}]}},
  ];
  const {send} = transport({
    'POST /translate': {ok: true, data: {job: 'abc', status: 'queued'}},
    'GET /job/abc': () => polls.shift(),
  });
  const partials = [], progress = [];
  const rows = await createApi(send, {sleep: noWait}).translate({cues: []}, {
    onPartial: r => partials.push(r.map(x => x.th)), onProgress: (d, t) => progress.push([d, t]),
  });
  assert.deepEqual(partials, [['ก', '']]);
  assert.deepEqual(progress, [[1, 3]]);
  assert.deepEqual(rows.map(r => r.th), ['ก', 'ข']);
});

test('a failed or cancelled job says why', async () => {
  for (const [status, error] of [['error', 'agy ล้มเหลว'], ['cancelled', '']]) {
    const {send} = transport({
      'POST /translate': {ok: true, data: {job: 'abc', status: 'queued'}},
      'GET /job/abc': {ok: true, data: {status, error}},
    });
    await assert.rejects(createApi(send, {sleep: noWait}).translate({cues: []}), err => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, status === 'error' ? /agy ล้มเหลว/ : /ยกเลิก/);
      return true;
    });
  }
});

test('moving to another lecture abandons the wait', async () => {
  let current = true;
  const {send} = transport({
    'POST /translate': {ok: true, data: {job: 'abc', status: 'queued'}},
    'GET /job/abc': () => { current = false; return {ok: true, data: {status: 'running', cues: []}}; },
  });
  await assert.rejects(
    createApi(send, {sleep: noWait}).translate({cues: []}, {isCurrent: () => current}),
    err => err instanceof Stale,
  );
});

test('speaking fetches the audio bytes and returns what the voice said', async () => {
  let posted;
  const {send} = transport({
    'POST /tts': (msg) => { posted = msg.body; return {ok: true, data: {url: '/audio/x.wav', text: 'สวัสดี'}}; },
    'GET /audio/x.wav': {ok: true, data: {base64: 'AAA=', type: 'audio/wav'}},
  });
  const clip = await createApi(send).speak({voice: 'seamless:th', text: 'Hola', lang: 'es'});
  assert.deepEqual(posted, {text: 'Hola', voice: 'seamless:th', source_lang: 'es'});
  assert.deepEqual(clip, {audio: {base64: 'AAA=', type: 'audio/wav'}, spokenText: 'สวัสดี'});
});

test('Thai text is sent without a source language', async () => {
  let posted;
  const {send} = transport({
    'POST /tts': (msg) => { posted = msg.body; return {ok: true, data: {url: '/audio/y.mp3'}}; },
    'GET /audio/y.mp3': {ok: true, data: {base64: 'AA==', type: 'audio/mpeg'}},
  });
  const clip = await createApi(send).speak({voice: 'th-TH-NiwatNeural', text: 'สวัสดี', lang: null});
  assert.deepEqual(posted, {text: 'สวัสดี', voice: 'th-TH-NiwatNeural'});
  assert.equal(clip.spokenText, null);
});

test('a server that is not running is reported as such, in plain Thai', async () => {
  const send = async () => ({ok: false, unreachable: true, error: 'Failed to fetch'});
  await assert.rejects(createApi(send).engines(), err => {
    assert.equal(err.kind, 'unreachable');
    assert.match(err.message, /start-server\.cmd/);
    return true;
  });
});

test('an extension reload is named, with the fix', async () => {
  const send = async () => { throw new Error('Extension context invalidated.'); };
  await assert.rejects(createApi(send).engines(), err => {
    assert.equal(err.kind, 'extension');
    assert.match(err.message, /F5/);
    return true;
  });
});

test('the engine catalogue includes what each engine can do', async () => {
  const {send} = transport({'GET /health': {ok: true, data: {ok: true, version: '1.3.0', engine: 'agy', a100: true, voices: [
    {name: 'seamless', label: 'Seamless', ready: true, translates: true, voices: [{id: 'seamless:th', label: 'ไทย'}]},
  ]}}});
  const api = createApi(send);
  const health = await api.health();
  assert.equal(health.version, '1.3.0');
  assert.equal(health.a100, true);
  assert.equal(health.llmEngine, 'agy');
  assert.deepEqual(health.engines, [{name: 'seamless', label: 'Seamless', ready: true, error: '', translates: true, voices: [{id: 'seamless:th', label: 'ไทย'}]}]);
});

test('queueing a lecture for later sends it as a batch job and does not wait', async () => {
  let posted;
  const {send, calls} = transport({'POST /translate': (msg) => { posted = msg.body; return {ok: true, data: {job: 'j', status: 'queued'}}; }});
  assert.deepEqual(await createApi(send).enqueue({lecture: '7', cues: []}), {cached: false, status: 'queued'});
  assert.equal(posted.batch, true);
  assert.deepEqual(calls, ['POST /translate']);
});

test('a running job hands over its id, and focus points it at the viewer', async () => {
  let job = null;
  let posted = null;
  const {send, calls} = transport({
    'POST /translate': {ok: true, data: {job: 'abc', status: 'queued'}},
    'GET /job/abc': {ok: true, data: {status: 'done', cues: []}},
    'POST /job/abc/focus': (msg) => { posted = msg.body; return {ok: true, data: {ok: true}}; },
  });
  const api = createApi(send, {sleep: noWait});
  await api.translate({cues: []}, {onJob: (id) => (job = id)});
  assert.equal(job, 'abc');
  await api.focus('abc', 412.5);
  assert.deepEqual(posted, {time: 412.5});
  assert.equal(calls.at(-1), 'POST /job/abc/focus');
});
