'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../lib/md');

test('markdown 基本渲染', () => {
  const html = render('# 标题\n\n**加粗**');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>加粗<\/strong>/);
});

test('html:false 原始标签被转义,不允许注入', () => {
  const html = render('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('email:true 包裹邮件正文容器样式', () => {
  const html = render('正文', { email: true });
  assert.ok(html.startsWith('<div style="'));
  assert.match(html, /PingFang SC/);
  assert.match(html, /正文/);
});

test('空输入渲染为空字符串', () => {
  assert.equal(render(''), '');
  assert.equal(render(null), '');
});
