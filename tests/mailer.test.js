'use strict';

/**
 * mailer 纯函数测试:只测地址格式化与报错翻译,不触碰网络、不真实发信。
 * 发送路径(sendItems)依赖真实 SMTP,不在单测范围——由 dry-run(preview)覆盖。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatAddress, explainSmtpError } = require('../lib/mailer');

test('formatAddress 无名字时返回裸地址', () => {
  assert.equal(formatAddress(null, 'a@b.c'), 'a@b.c');
  assert.equal(formatAddress('', 'a@b.c'), 'a@b.c');
});

test('formatAddress 组装 name <email> 并剥离名字中的引号', () => {
  assert.equal(formatAddress('张三', 'a@b.c'), '"张三" <a@b.c>');
  assert.equal(formatAddress('张"三"', 'a@b.c'), '"张三" <a@b.c>');
});

test('explainSmtpError 网易 535 提示必须用授权码', () => {
  const tips = explainSmtpError('535 authentication failed', 'smtp.163.com');
  assert.ok(tips.some((t) => t.includes('授权码')));
  assert.ok(tips.some((t) => t.includes('网易')));
});

test('explainSmtpError 非网易 535 给通用认证提示', () => {
  const tips = explainSmtpError('535 authentication failed', 'smtp.example.com');
  assert.ok(tips.some((t) => t.includes('认证失败')));
  assert.ok(!tips.some((t) => t.includes('网易')));
});

test('explainSmtpError 554 反垃圾与超时网络类分别给提示', () => {
  const spam = explainSmtpError('554 DT:SPM', 'smtp.126.com');
  assert.ok(spam.some((t) => t.includes('反垃圾')));
  const net = explainSmtpError('ETIMEDOUT', '');
  assert.ok(net.some((t) => t.includes('网络不通')));
});

test('explainSmtpError 未知报错返回空提示列表', () => {
  assert.deepEqual(explainSmtpError('something odd', ''), []);
});
