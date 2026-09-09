'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render, extractVars, builtinVars } = require('../lib/render');

test('render 替换已知变量并收集缺失占位符', () => {
  const { text, missing } = render('{姓名}你好,工单{工单号}({状态})', {
    姓名: '张三',
    工单号: 'GD-1',
  });
  assert.equal(text, '张三你好,工单GD-1({状态})');
  assert.deepEqual(missing, ['状态']);
});

test('render 空值视为缺失,保留原占位符', () => {
  const { text, missing } = render('a={x} b={y}', { x: '', y: null });
  assert.equal(text, 'a={x} b={y}');
  assert.deepEqual(missing.sort(), ['x', 'y']);
});

test('render 对 null/undefined 模板返回空文本', () => {
  assert.deepEqual(render(undefined, {}), { text: '', missing: [] });
  assert.deepEqual(render(null, {}), { text: '', missing: [] });
});

test('extractVars 去重并保留出现顺序', () => {
  assert.deepEqual(extractVars('{a} {b} {a}'), ['a', 'b']);
  assert.deepEqual(extractVars(''), []);
  assert.deepEqual(extractVars(null), []);
});

test('builtinVars 生成日期类内置变量', () => {
  const vars = builtinVars(new Date(2026, 8, 9, 14, 5));
  assert.equal(vars['日期'], '2026-09-09');
  assert.equal(vars['日期中文'], '2026年9月9日');
  assert.equal(vars['年月'], '2026-09');
  assert.equal(vars['年份'], '2026');
  assert.equal(vars['月份'], '09');
  assert.equal(vars['昨日'], '2026-09-08');
  assert.equal(vars['明日'], '2026-09-10');
});
