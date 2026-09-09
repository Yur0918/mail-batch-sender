'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitAddresses } = require('../lib/plan');
const { splitAddresses: splitDraft } = require('../lib/draft');

const CASES = [
  ['单一地址', 'a@b.c', ['a@b.c']],
  ['英文逗号与分号', 'a@b.c, c@d.e;f@g.h', ['a@b.c', 'c@d.e', 'f@g.h']],
  ['中文逗号分号与空白', 'a@b.c,c@d.e;f@g.h x@y.z', ['a@b.c', 'c@d.e', 'f@g.h', 'x@y.z']],
  ['空串与空白', '   ', []],
  ['null/undefined', null, []],
];

for (const [name, input, expected] of CASES) {
  test(`plan.splitAddresses:${name}`, () => {
    assert.deepEqual(splitAddresses(input), expected);
  });
  test(`draft.splitAddresses:${name}`, () => {
    assert.deepEqual(splitDraft(input), expected);
  });
}
