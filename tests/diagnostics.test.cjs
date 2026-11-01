const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createDiagnostics, redact} = require('../extension/core/diagnostics.js');

test('diagnostics redact credentials and URL query strings before local storage', () => {
  const result = redact('403 wss://user:pass@host/tts?key=hidden Bearer credential sk-private-value api_key=another "api_key":"opaque-secret"');
  for (const secret of ['user:pass', 'hidden', 'credential', 'sk-private-value', 'another', 'opaque-secret']) assert.ok(!result.includes(secret));
});

test('offline errors remain bounded and upload after recovery without request bodies', async () => {
  let data = {}, time = 0, online = false;
  const received = [];
  const store = {get: async () => data, set: async value => {data = {...data, ...value};}};
  const d = createDiagnostics({storage:store, now:()=>time, post:async events => {
    if (!online) throw new Error('offline');
    received.push(events); return true;
  }});
  await Promise.all(Array.from({length:105}, (_,i)=>d.record({source:'api',message:`error ${i}`,body:'lesson text',key:'private'})));
  await d.flush();
  assert.equal(data.udthErrorOutbox.length,100);
  online = true; time = 11000;
  await d.flush();
  assert.equal(received[0].length,100);
  assert.equal(data.udthErrorOutbox.length,0);
  assert.equal(received[0][0].body,undefined);
  assert.equal(received[0][0].key,undefined);
});
