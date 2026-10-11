// "เลือกอัตโนมัติ" must resolve inside the selected engine, never to Edge.
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

function voiceFor(state) {
  const engines = [
    {name: 'edge', voices: [{id: 'th-TH-NiwatNeural'}]},
    {name: 'seamless', voices: [{id: 'seamless:th'}]},
    {name: 'omnivoice', voices: [{id: 'omnivoice:male'}, {id: 'omnivoice:female'}]},
  ];
  const c = vm.createContext({
    state: {nativeVoices: [], ttsVoice: '', ...state},
    DEFAULT_TTS_VOICE: 'th-TH-NiwatNeural',
    engineByName: name => engines.find(e => e.name === name) || {name, voices: []},
  });
  vm.runInContext(fn('currentVoice'), c);
  return c.currentVoice();
}

test('automatic voice stays inside the selected engine', () => {
  assert.equal(voiceFor({ttsEngine: 'seamless'}), 'seamless:th');
  assert.equal(voiceFor({ttsEngine: 'omnivoice'}), 'omnivoice:male');
  assert.equal(voiceFor({ttsEngine: 'edge'}), 'th-TH-NiwatNeural');
});

test('an explicit voice always wins', () => {
  assert.equal(voiceFor({ttsEngine: 'omnivoice', ttsVoice: 'omnivoice:female'}), 'omnivoice:female');
});

test('a stale voice saved from another engine is ignored', () => {
  assert.equal(voiceFor({ttsEngine: 'seamless', ttsVoice: 'th-TH-NiwatNeural'}), 'seamless:th');
});

test('the browser engine uses a native voice, not a server one', () => {
  assert.equal(voiceFor({ttsEngine: 'windows', nativeVoices: [{name: 'Microsoft Niwat Online'}]}), 'Microsoft Niwat Online');
});

test('synthesis requests go through currentVoice, not a fixed default', () => {
  assert.match(source, /payload: \{ text: segment\.text, voice: currentVoice\(\) \}/);
  assert.doesNotMatch(source, /state\.ttsVoice \|\| DEFAULT_TTS_VOICE/);
});
