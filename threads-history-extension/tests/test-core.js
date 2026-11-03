const assert = require('node:assert/strict');
const { parsePostUrl, cleanText, visibilityRatio, eligibleRevisit } = require('../core.js');
const valid = [
  ['https://www.threads.com/@tester/post/CABxABC1234?utm_source=chat', 'CABxABC1234'],
  ['https://threads.net/@tester/post/CABxABC1234', 'CABxABC1234'],
  ['https://threads.com/t/CABxABC1234', 'CABxABC1234'],
  ['/@tester/post/CABxABC1234', 'CABxABC1234']
];
for (const [url, code] of valid) {
  assert.equal(parsePostUrl(url).id, code);
  assert.ok(parsePostUrl(url).url.startsWith('https://www.threads.com/'));
}
for (const url of ['https://evil.example/@tester/post/CABxABC1234',
  'javascript:alert(1)', 'https://threads.com/@tester',
  'https://threads.com/@tester/post/x']) assert.equal(parsePostUrl(url), null);
assert.equal(cleanText(' A\u200B\n\n\n B  '), 'A\n\nB');
assert.equal(visibilityRatio({ top: 0, left: 0, right: 600, bottom: 300, width: 600, height: 300 }, 600, 500), 1);
assert.equal(visibilityRatio({ top: 200, left: 0, right: 600, bottom: 600, width: 600, height: 400 }, 600, 500), .75);
assert.equal(eligibleRevisit(0, 0, 10000, 45000, 3200), true);
assert.equal(eligibleRevisit(1000, 2000, 60000, 45000, 3200), true);
assert.equal(eligibleRevisit(1000, 59000, 60000, 45000, 3200), false);
assert.equal(eligibleRevisit(1000, 2000, 30000, 45000, 3200), false);
console.log('PASS: URL normalization, text cleanup, visibility and revisit rules');
