// The interface in Thai or English: every message on screen has an English
// version, and the language follows the user's choice.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../extension/core/i18n.js');
const {normalize} = require('../extension/core/settings.js');

const EXT = path.join(__dirname, '..', 'extension');
const read = (file) => fs.readFileSync(path.join(EXT, file), 'utf8');
const scripts = () => fs.readdirSync(EXT, {recursive: true})
  .filter((f) => f.endsWith('.js') && !f.includes('i18n.js'))
  .map((f) => [f, read(f)]);

// Everything the code shows through the table: t("...") literals, the skip
// reasons main.js translates by code, and the marked text in popup.html.
function messagesInUse() {
  const found = new Map();
  const add = (text, where) => found.set(JSON.parse(`"${text}"`), where);
  for (const [file, src] of scripts()) {
    for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) add(m[1], file);
  }
  const reasons = read('main.js').match(/const SKIP_REASONS = \{([\s\S]*?)\n  \};/)[1];
  for (const m of reasons.matchAll(/:\s*"((?:[^"\\]|\\.)*)"/g)) add(m[1], 'main.js SKIP_REASONS');
  const html = read('popup.html');
  for (const m of html.matchAll(/<(\w+)[^>]*\bdata-i18n(?:-html)?(?=[\s>])[^>]*>([\s\S]*?)<\/\1>/g)) {
    found.set(m[2].trim(), 'popup.html');
  }
  for (const m of html.matchAll(/aria-label="([^"]*)"[^>]*\bdata-i18n-aria\b/g)) found.set(m[1], 'popup.html');
  return found;
}

test('every message on screen has an English version', () => {
  const missing = [...messagesInUse()].filter(([text]) => !(text in i18n.EN)).map(([text, where]) => `${where}: ${text}`);
  assert.deepEqual(missing, []);
});

test('the English table has nothing the code no longer says', () => {
  const used = messagesInUse();
  assert.deepEqual(Object.keys(i18n.EN).filter((text) => !used.has(text)), []);
});

test('placeholders survive translation', () => {
  for (const [th, en] of Object.entries(i18n.EN)) {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(en), names(th), th);
  }
});

test('the choice is the user\'s; "auto" follows the browser', () => {
  assert.equal(i18n.resolve('en', 'th-TH'), 'en');
  assert.equal(i18n.resolve('th', 'en-US'), 'th');
  assert.equal(i18n.resolve('auto', 'th-TH'), 'th');
  assert.equal(i18n.resolve('auto', 'th'), 'th');
  assert.equal(i18n.resolve('auto', 'en-GB'), 'en');
  assert.equal(i18n.resolve('auto', ''), 'en');
});

test('messages read in the chosen language, with their values filled in', () => {
  try {
    i18n.setLang('en');
    assert.equal(i18n.t('แปลไม่สำเร็จ: {reason}', {reason: 'timeout'}), 'Translation failed: timeout');
    i18n.setLang('th');
    assert.equal(i18n.t('แปลไม่สำเร็จ: {reason}', {reason: 'timeout'}), 'แปลไม่สำเร็จ: timeout');
    assert.equal(i18n.t('ข้อความที่ไม่มีในตาราง'), 'ข้อความที่ไม่มีในตาราง', 'an unknown message shows as written');
  } finally {
    i18n.setLang('th');
  }
});

test('the interface language is a setting, "auto" unless chosen', () => {
  assert.equal(normalize({}).lang, 'auto');
  assert.equal(normalize({lang: 'en'}).lang, 'en');
  assert.equal(normalize({lang: 'fr'}).lang, 'auto');
});
