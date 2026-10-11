// Which caption track each site translates from.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Load a site script into a sandbox with just the browser bits it touches.
function loadSites({fetchText = {}} = {}) {
  const context = vm.createContext({
    console, URL, setTimeout, clearTimeout, Intl,
    location: {hostname: 'www.udemy.com', pathname: '/course/x/learn/lecture/1', href: 'https://www.udemy.com/course/x/learn/lecture/1'},
    // sites.js keeps a <textarea> for decoding HTML entities in YouTube captions.
    document: {querySelector: () => null, querySelectorAll: () => [], createElement: () => ({})},
    chrome: {runtime: {sendMessage: async () => ({})}},
    fetch: async (url) => ({ok: url in fetchText, text: async () => fetchText[url]}),
  });
  context.window = context;
  context.addEventListener = () => {};
  context.globalThis = context;
  for (const file of ['extension/sites.js', 'extension/sites/udemy.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, {filename: file});
  }
  return context.UDTH;
}

const vtt = (line) => `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${line}\n`;

test('YouTube: the spoken language wins over an added English subtitle', () => {
  const UDTH = loadSites();
  const pick = UDTH.youtube.__pickSourceTrack;
  const t = (languageCode, kind = '') => ({languageCode, kind, baseUrl: 'u'});
  assert.equal(pick([t('en'), t('es'), t('es', 'asr')]).languageCode, 'es');
  assert.equal(pick([t('en'), t('es', 'asr')]).languageCode, 'en', 'human English beats machine Spanish');
  assert.equal(pick([t('hi', 'asr')]).languageCode, 'hi');
  assert.equal(pick([t('th'), t('en', 'asr')]).languageCode, 'en', 'never translate from Thai');
});

test('Udemy: a Spanish course is translated from its Spanish captions', async () => {
  const UDTH = loadSites({fetchText: {'es.vtt': vtt('Hola a todos.'), 'en.vtt': vtt('Hello everyone.')}});
  const result = await UDTH.udemy.videoCues({
    locale: 'es_ES',
    captions: [
      {locale_id: 'en_US', source: 'auto', url: 'en.vtt'},
      {locale_id: 'es_ES', source: 'manual', url: 'es.vtt'},
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.sourceLang, 'ES-ES');
  assert.deepEqual(Array.from(result.cues, c => c.text), ['Hola a todos.']);
});

test('Udemy: an English course keeps using its English captions', async () => {
  const UDTH = loadSites({fetchText: {'en.vtt': vtt('Hello everyone.')}});
  const result = await UDTH.udemy.videoCues({locale: 'en_US', captions: [{locale_id: 'en_US', source: 'manual', url: 'en.vtt'}]});
  assert.equal(result.sourceLang, 'EN-US');
  assert.deepEqual(Array.from(result.cues, c => c.text), ['Hello everyone.']);
});

test('Udemy: human-made Thai captions mean there is nothing to do', async () => {
  const UDTH = loadSites();
  const result = await UDTH.udemy.videoCues({locale: 'en_US', captions: [{locale_id: 'th_TH', source: 'manual', url: 'th.vtt'}]});
  assert.deepEqual({...result}, {ok: false, code: 'native-thai'});
});

test('Udemy: a lecture with no usable captions says so', async () => {
  const UDTH = loadSites();
  const result = await UDTH.udemy.videoCues({locale: 'en_US', captions: []});
  assert.deepEqual({...result}, {ok: false, code: 'no-english'});
});
