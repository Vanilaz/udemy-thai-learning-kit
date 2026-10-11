// Where the dub's words come from, and which caption track counts as the source.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('extension/content.js', 'utf8');
const sites = fs.readFileSync('extension/sites.js', 'utf8');
function fn(src, name) {
  const match = new RegExp(`^(?:  )?(?:async )?function ${name}\\(`, 'm').exec(src);
  assert.ok(match, `Missing function ${name}`);
  const text = src.slice(match.index);
  const indent = match[0].startsWith('  ') ? '  ' : '';
  return text.slice(0, new RegExp(`^${indent}}`, 'm').exec(text).index + indent.length + 1);
}

function planner(state) {
  const c = vm.createContext({
    state: {sourceLang: 'ES', dub: {}, ttsEngine: 'seamless', dubSource: 'auto', ...state},
    engineByName: name => ({name, translates: name === 'seamless'}),
    SEGMENT_GAP_SECONDS: 1.2,
    MAX_SEGMENT_SECONDS: 14,
  });
  vm.runInContext(['endsSentence', 'speaksFromSource', 'speechFor', 'buildDubSegments'].map(n => fn(source, n)).join('\n'), c);
  return c;
}

// Two sentences; only the first is fully translated so far.
const cues = [
  {start: 0, end: 2, en: 'Creamos una variable', th: 'เราสร้างตัวแปร'},
  {start: 2, end: 4, en: 'dentro del bucle.', th: 'ในลูป'},
  {start: 4, end: 6, en: 'Luego la imprimimos', th: 'จากนั้นพิมพ์ออกมา'},
  {start: 6, end: 8, en: 'en la consola.', th: ''},
];

test('auto: translated sentences use the AI Thai, the rest go to Seamless with their language', () => {
  const c = planner({});
  const segs = c.buildDubSegments(cues);
  assert.equal(segs.length, 2);
  assert.deepEqual({...c.speechFor(segs[0])}, {text: 'เราสร้างตัวแปร ในลูป', sourceLang: null});
  assert.deepEqual({...c.speechFor(segs[1])}, {text: 'Luego la imprimimos en la consola.', sourceLang: 'es'});
});

test('segment boundaries do not move when the translation streams in', () => {
  const c = planner({});
  const before = c.buildDubSegments(cues).map(s => [s.start, s.end]);
  const after = c.buildDubSegments(cues.map(q => ({...q, th: q.th || 'ในคอนโซล'}))).map(s => [s.start, s.end]);
  assert.deepEqual(after, before);
});

test('direct: always the original, even where Thai exists', () => {
  const c = planner({dubSource: 'direct'});
  const segs = c.buildDubSegments(cues);
  assert.equal(c.speechFor(segs[0]).sourceLang, 'es');
  assert.equal(c.speechFor(segs[0]).text, 'Creamos una variable dentro del bucle.');
});

test('thai, or any engine that cannot translate: only Thai is spoken, untranslated lines are skipped', () => {
  for (const state of [{dubSource: 'thai'}, {ttsEngine: 'edge'}]) {
    const c = planner(state);
    const segs = c.buildDubSegments(cues);
    assert.ok(segs.every(s => c.speechFor(s).sourceLang === null), JSON.stringify(state));
    assert.ok(segs.every(s => !/[a-z]{3}/i.test(c.speechFor(s).text)), JSON.stringify(state));
  }
});

test('YouTube: the spoken language wins over an added English subtitle', () => {
  const c = vm.createContext({});
  vm.runInContext(fn(sites, 'pickSourceTrack'), c);
  const t = (languageCode, kind = '') => ({languageCode, kind, baseUrl: 'u'});
  assert.equal(c.pickSourceTrack([t('en'), t('es'), t('es', 'asr')]).languageCode, 'es');
  // Nothing written in the spoken language: human English beats machine Spanish.
  assert.equal(c.pickSourceTrack([t('en'), t('es', 'asr')]).languageCode, 'en');
  assert.equal(c.pickSourceTrack([t('hi', 'asr')]).languageCode, 'hi');
  assert.equal(c.pickSourceTrack([t('en-US'), t('en', 'asr')]).languageCode, 'en-US');
});

test('Udemy asks for the course locale and translates from that language', () => {
  assert.match(source, /fields\[course\]=id,locale/);
  assert.match(source, /const original = pickCaption\(captions, spoken\)/);
});
