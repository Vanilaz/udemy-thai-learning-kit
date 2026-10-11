// The timeline is the one model both subtitles and dubbing read.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createTimeline} = require('../extension/core/timeline.js');

// Udemy-style fragments: a sentence cut into short display pieces.
const source = [
  {start: 0.0, end: 1.5, text: 'So the function takes'},
  {start: 1.5, end: 3.0, text: 'a name and returns'},
  {start: 3.0, end: 4.2, text: 'a greeting string.'},
  {start: 4.4, end: 6.0, text: 'Now we call it'},
  {start: 6.0, end: 7.5, text: 'with your name.'},
  {start: 12.0, end: 14.0, text: 'Next lesson covers loops.'},
];
const thai = ['ฟังก์ชันนี้รับ', 'ชื่อเข้ามาแล้วคืนค่า', 'เป็นข้อความทักทาย', 'ตอนนี้เราเรียกมัน', 'ด้วยชื่อของคุณ', 'บทต่อไปพูดเรื่องลูป'];
const rows = (upto) => source.map((c, i) => ({start: c.start, end: c.end, en: c.text, th: i < upto ? thai[i] : ''}));

test('fragments become whole sentences with ids that never change', () => {
  const t = createTimeline(source, {lang: 'EN'});
  assert.deepEqual(t.sentences.map(s => [s.start, s.end, s.source]), [
    [0, 4.2, 'So the function takes a name and returns a greeting string.'],
    [4.4, 7.5, 'Now we call it with your name.'],
    [12, 14, 'Next lesson covers loops.'],
  ]);
  const ids = t.sentences.map(s => s.id);
  t.applyTranslation(rows(2));
  t.applyTranslation(rows(6));
  assert.deepEqual(t.sentences.map(s => s.id), ids);
  assert.equal(new Set(ids).size, 3);
});

test('a sentence is final only when every fragment of it is translated', () => {
  const t = createTimeline(source, {lang: 'EN'});
  assert.deepEqual(t.applyTranslation(rows(2)), []);
  assert.equal(t.sentences[0].final, null);
  assert.deepEqual(t.applyTranslation(rows(3)), [t.sentences[0].id]);
  assert.equal(t.sentences[0].final, 'ฟังก์ชันนี้รับ ชื่อเข้ามาแล้วคืนค่า เป็นข้อความทักทาย');
});

test('a draft fills in until the final translation replaces it', () => {
  const t = createTimeline(source, {lang: 'ES'});
  const [first] = t.sentences;
  assert.equal(t.setDraft(first.id, 'ฉบับร่าง'), true);
  assert.deepEqual(t.captionAt(1), {text: 'ฉบับร่าง', source: first.source, quality: 'draft', start: 0, end: 4.4});
  t.applyTranslation(rows(3));
  assert.equal(t.captionAt(1).quality, 'final');
  assert.equal(t.setDraft(first.id, 'ช้าไป'), false, 'a late draft never overwrites the final text');
});

test('with nothing translated the caption is the original, once', () => {
  const t = createTimeline(source, {lang: 'ES'});
  assert.deepEqual(t.captionAt(5), {text: 'Now we call it with your name.', source: 'Now we call it with your name.', quality: 'source', start: 4.4, end: 7.5});
  assert.equal(t.captionAt(10), null, 'nothing is shown in a real gap');
});

test('a caption is held through a short pause so it does not flicker', () => {
  const t = createTimeline(source, {lang: 'EN'});
  // 4.2 to 4.4 is a breath between sentences: the first one stays up.
  const held = t.captionAt(4.3);
  assert.match(held.source, /a greeting string\.$/, 'the end of the first sentence');
  assert.equal(held.end, 4.4);
});

test('a long sentence is shown in readable chunks cut on word boundaries', () => {
  const longThai = 'คำ'.repeat(25) + ' ' + 'ยาว'.repeat(25);
  const t = createTimeline([{start: 0, end: 10, text: 'A very long sentence.'}], {lang: 'EN'});
  t.applyTranslation([{start: 0, end: 10, en: 'A very long sentence.', th: longThai}]);
  const shown = [];
  for (let time = 0; time < 10; time += 0.05) {
    const caption = t.captionAt(time);
    if (shown.at(-1) !== caption) shown.push(caption);
  }
  assert.ok(shown.length > 1, 'split into more than one chunk');
  assert.ok(shown.every(c => c.text.length <= 60), 'no chunk longer than two lines');
  assert.equal(shown.map(c => c.text).join('').replace(/\s/g, ''), longThai.replace(/\s/g, ''), 'no text lost or repeated');
  assert.equal(shown[0].start, 0);
  assert.equal(shown.at(-1).end, 10);
});

test('translated runway is measured from the playhead and stops at the first gap', () => {
  const t = createTimeline(source, {lang: 'EN'});
  t.applyTranslation(rows(5));
  assert.equal(t.finalCoverage(0), 7.5);
  assert.equal(t.finalCoverage(12), 0);
  t.applyTranslation(rows(6));
  assert.equal(t.finalCoverage(12), 2);
  assert.equal(t.translatedToEnd(12), true);
});

test('the next sentence to speak is the first one not over yet', () => {
  const t = createTimeline(source, {lang: 'EN'});
  assert.equal(t.nextIndexAt(0), 0);
  assert.equal(t.nextIndexAt(5), 1);
  assert.equal(t.nextIndexAt(9), 2);
  assert.equal(t.nextIndexAt(20), 3);
});

test('each sentence may run until the next one starts', () => {
  const t = createTimeline(source, {lang: 'EN'});
  assert.deepEqual(t.sentences.map(s => s.budgetEnd), [4.4, 12, 17]);
});

test('under a long sentence, each chunk shows its share of the original', () => {
  const english = 'one two three four five six seven eight nine ten.';
  const t = createTimeline([{start: 0, end: 10, text: english}], {lang: 'EN'});
  t.applyTranslation([{th: 'ก'.repeat(60) + ' ' + 'ข'.repeat(60)}]);
  const first = t.captionAt(0.1), last = t.captionAt(9.9);
  assert.notEqual(first.source, last.source);
  assert.equal(`${first.source} ${last.source}`, english, 'every word once, in order');
});
