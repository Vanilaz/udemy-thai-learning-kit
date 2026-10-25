const { test } = require('node:test');
const assert = require('node:assert/strict');

// Set up minimal browser globals for overlay.js
globalThis.UDTH = globalThis.UDTH || {};
globalThis.document = {
  createElement(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: '',
      textContent: '',
      childNodes: [],
      appendChild(child) {
        this.childNodes.push(child);
      },
    };
  },
  createTextNode(text) {
    return {
      nodeType: 3,
      nodeValue: text,
      textContent: text,
    };
  },
};

const { formatThaiSpacing, wordSpans } = require('../extension/ui/overlay.js');

test('formatThaiSpacing adds spaces between Thai and English characters', () => {
  assert.equal(
    formatThaiSpacing('เราจะใช้AngularCLIเพื่อสร้างเว็บ'),
    'เราจะใช้ AngularCLI เพื่อสร้างเว็บ'
  );
  assert.equal(
    formatThaiSpacing('แอปพลิเคชันAngularของเรา'),
    'แอปพลิเคชัน Angular ของเรา'
  );
});

test('formatThaiSpacing preserves existing spaces', () => {
  assert.equal(
    formatThaiSpacing('เราจะใช้ Angular CLI เพื่อสร้างเว็บ'),
    'เราจะใช้ Angular CLI เพื่อสร้างเว็บ'
  );
});

test('wordSpans creates text nodes for spaces so whitespace is never collapsed to zero width', () => {
  const span = wordSpans('เราจะใช้ Angular CLI เพื่อสร้างเว็บ');
  const spaceNodes = span.childNodes.filter(n => n.nodeType === 3 && n.nodeValue === ' ');
  assert.ok(spaceNodes.length >= 3, 'Spaces must be preserved as real text nodes');
});
