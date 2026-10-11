// Run the real ensureVoiceReady from content.js against a scripted server.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/content.js', 'utf8');
function fn(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing function ${name}`);
  const text = source.slice(match.index);
  return text.slice(0, /^  }/m.exec(text).index + 3);
}

// `phases` is what the server answers on each successive warmup poll.
function harness({engine = 'seamless', status = 'ready', phases}) {
  const calls = {gate: [], hide: 0, resync: 0, status: [], polls: 0};
  const c = vm.createContext({
    state: {ttsEngine: engine, dubbingEnabled: true, status, dub: {cursor: 0}},
    voiceWarm: {token: 0, gated: false},
    chrome: {runtime: {sendMessage: async () => {
      const phase = phases[Math.min(calls.polls, phases.length - 1)];
      calls.polls += 1;
      return phase === 'offline' ? {ok: false} : {ok: true, data: {state: phase, error: phase === 'error' ? 'CUDA OOM' : ''}};
    }}},
    engineByName: name => ({label: name}),
    showGate: (title) => calls.gate.push(title),
    hideGate: () => { calls.hide += 1; },
    resyncDub: () => { calls.resync += 1; },
    prefetchAudio: () => {},
    renderStatus: (text, kind) => calls.status.push([kind, text]),
    setPanelNote: () => {},
    log: () => {},
    // A macrotask, like the real setTimeout: a microtask-only loop would
    // starve the event loop and the test could never change state mid-load.
    sleep: () => new Promise(setImmediate),
  });
  vm.runInContext(fn('ensureVoiceReady'), c);
  return {c, calls};
}

test('a loading local voice holds the ready lecture, then releases it once loaded', async () => {
  const {c, calls} = harness({phases: ['loading', 'loading', 'loaded']});
  await c.ensureVoiceReady();
  assert.equal(calls.gate.length, 2);
  assert.match(calls.gate[0], /กำลังโหลดเสียงพากย์ seamless/);
  assert.equal(calls.hide, 1);
  assert.equal(calls.resync, 1);
  assert.equal(c.voiceWarm.gated, false);
});

test('while the translation is still running, the model loads without a second gate', async () => {
  const {c, calls} = harness({status: 'translating', phases: ['loading', 'loaded']});
  await c.ensureVoiceReady();
  assert.equal(calls.gate.length, 0);
  assert.equal(calls.hide, 0);
});

test('hosted voices, browser voices and an unreachable server never hold the video', async () => {
  for (const [engine, phases] of [['edge', ['none']], ['windows', ['loading']], ['seamless', ['offline']]]) {
    const {c, calls} = harness({engine, phases});
    await c.ensureVoiceReady();
    assert.equal(calls.gate.length, 0, engine);
  }
});

test('a failed load releases the video and says why', async () => {
  const {c, calls} = harness({phases: ['loading', 'error']});
  await c.ensureVoiceReady();
  assert.equal(calls.hide, 1);
  assert.equal(c.voiceWarm.gated, false);
  assert.deepEqual(calls.status.at(-1)[0], 'error');
  assert.match(calls.status.at(-1)[1], /CUDA OOM/);
});

test('switching away from the loading voice releases the hold', async () => {
  const {c, calls} = harness({phases: ['loading']});
  const first = c.ensureVoiceReady();
  await new Promise(setImmediate);
  c.state.ttsEngine = 'edge';
  c.chrome.runtime.sendMessage = async () => ({ok: true, data: {state: 'none'}});
  await Promise.all([first, c.ensureVoiceReady()]);
  assert.ok(calls.gate.length >= 1);
  assert.equal(c.voiceWarm.gated, false);
  assert.equal(calls.hide, 1);
});
