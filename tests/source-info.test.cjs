const {test} = require('node:test');
const assert = require('node:assert/strict');
globalThis.UDTH = {i18n: require('../extension/core/i18n.js')};
const {describeSource} = require('../extension/ui/menu.js');

test('fallback captions are never presented as verified instructor language', () => {
  UDTH.i18n.setLang('th');
  const text = describeSource({language:'en-US', kind:'auto', fallback:true, courseLanguage:'es_ES'});
  assert.match(text, /ซับสำรอง/);
  assert.match(text, /อาจผ่านการแปล/);
  assert.doesNotMatch(text, /ตรงกับภาษาที่คอร์สระบุ/);
});

test('CC is a caption label, not a claim a human verified the speech', () => {
  UDTH.i18n.setLang('th');
  assert.match(describeSource({language:'en', kind:'cc', courseLanguage:'en_US'}), /ซับ CC/);
  assert.match(describeSource({language:'en', kind:'cc'}), /ยังไม่ยืนยัน/);
  assert.equal(describeSource(null), 'กำลังตรวจแหล่งซับ');
});
