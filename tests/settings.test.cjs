// One settings model, shared by the popup and the in-player menu.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createSettingsStore} = require('../extension/core/settings.js');

// An in-memory stand-in for chrome.storage.local with the same contract.
function memoryStorage(initial = {}) {
  let data = {...initial};
  const listeners = [];
  return {
    data: () => data,
    area: {
      get: async (keys) => Object.fromEntries((keys || Object.keys(data)).filter(k => k in data).map(k => [k, data[k]])),
      set: async (items) => {
        const changes = {};
        for (const [k, v] of Object.entries(items)) { changes[k] = {oldValue: data[k], newValue: v}; data = {...data, [k]: v}; }
        listeners.forEach(fn => fn(changes, 'local'));
      },
      remove: async (keys) => { data = Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k))); },
    },
    onChanged: {addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1)},
  };
}

test('a fresh install starts paused (active: false), shows Thai with the original when turned on, and dubbing starts off', async () => {
  const settings = await createSettingsStore(memoryStorage()).load();
  assert.equal(settings.active, false);
  assert.equal(settings.subtitles, 'both');
  assert.equal(settings.dub.on, false);
  assert.equal(settings.dub.voice, '', 'no voice pinned: the engine picks its first');
});

test('the master power switch can be turned on and off', async () => {
  const store = createSettingsStore(memoryStorage());
  assert.equal((await store.load()).active, false);
  assert.equal((await store.save({active: true})).active, true);
  assert.equal((await store.save({active: false})).active, false);
});

test('settings saved by the old version carry over', async () => {
  const mem = memoryStorage({
    enabled: true, dualMode: false, capSize: 'l', dubbingEnabled: true, ttsEngine: 'seamless',
    ttsVoice: 'seamless:th', dubSource: 'thai', dubbingVolume: 0.8, originalAudioVolume: 0.3, dubRateCap: 1.4,
  });
  const store = createSettingsStore(mem);
  assert.deepEqual(await store.load(), {
    v: 2, active: true, subtitles: 'th', textSize: 'l', lang: 'th',
    dub: {on: true, engine: 'seamless', voice: 'seamless:th', start: 'accurate', volume: 0.8, sourceVolume: 0.3, maxRate: 1.4},
  });
  assert.ok(!('dualMode' in mem.data()), 'old keys are removed once migrated');
  assert.equal(mem.data().settings.v, 2);
});

test('subtitles switched off in the old version stay off', async () => {
  const store = createSettingsStore(memoryStorage({enabled: false, dualMode: true}));
  const loaded = await store.load();
  assert.equal(loaded.active, false);
  assert.equal(loaded.subtitles, 'off');
});

test('a partial update keeps everything else, and nonsense is replaced by defaults', async () => {
  const store = createSettingsStore(memoryStorage());
  await store.save({dub: {on: true}});
  const saved = await store.save({textSize: 'huge', dub: {volume: 7, maxRate: 0.2}});
  assert.equal(saved.dub.on, true);
  assert.equal(saved.textSize, 'm');
  assert.equal(saved.dub.volume, 1, 'volume is clamped to 0..1');
  assert.equal(saved.dub.maxRate, 1, 'speed-up cannot go below 1x');
});

test('changing the engine forgets a voice that belonged to the old engine', async () => {
  const store = createSettingsStore(memoryStorage());
  await store.save({dub: {engine: 'edge', voice: 'th-TH-NiwatNeural'}});
  assert.equal((await store.save({dub: {engine: 'seamless'}})).dub.voice, '');
  assert.equal((await store.save({dub: {engine: 'omnivoice', voice: 'omnivoice:female'}})).dub.voice, 'omnivoice:female');
});

test('every open view hears a change made in another one', async () => {
  const mem = memoryStorage();
  const popup = createSettingsStore(mem);
  const page = createSettingsStore(mem);
  const heard = [];
  page.subscribe(s => heard.push(s.subtitles));
  await popup.save({subtitles: 'off'});
  assert.deepEqual(heard, ['off']);
});

test('the interface language: a new install follows the browser, earlier users stay in Thai', async () => {
  assert.equal((await createSettingsStore(memoryStorage()).load()).lang, 'auto');
  const before120 = memoryStorage({settings: {v: 2, subtitles: 'th', textSize: 'm', dub: {}}});
  assert.equal((await createSettingsStore(before120).load()).lang, 'th');
  const chosen = memoryStorage({settings: {v: 2, lang: 'en', dub: {}}});
  assert.equal((await createSettingsStore(chosen).load()).lang, 'en');
});
