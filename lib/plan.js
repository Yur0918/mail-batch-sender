'use strict';

/**
 * 把 Excel 配置编译成「待发邮件清单」，并做全量校验。
 * 多对多模型：一个类型(模板) × 多个平台(收件人) = 多封邮件。
 * 校验不通过的条目会带上 errors，由调用方决定拒发。
 */

const fs = require('fs');
const path = require('path');
const { render, builtinVars } = require('./render');
const { render: renderMd } = require('./md');

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function splitAddresses(raw) {
  return String(raw || '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveAttachment(name, attachDir) {
  const p = path.isAbsolute(name) ? name : path.join(attachDir, name);
  return path.resolve(p);
}

/**
 * @param {object} wb   loadWorkbook 的返回值
 * @param {object} opts
 *   type          类型名称（必填）
 *   platformRows  只编译这些行号的平台（可选，用于发送时勾选子集）
 *   attachDir     附件根目录
 *   overrides     发送时变量覆盖，如 { 对接联系人: '张三' }
 *   now
 */
function buildPlan(wb, opts) {
  const { type, platformRows, attachDir, overrides, now } = opts;
  const base = builtinVars(now || new Date());

  const t = wb.types.get(type);
  const globalErrors = [];
  if (!t) {
    globalErrors.push(`类型「${type}」在「类型」sheet 中不存在`);
    return { items: [], globalErrors };
  }

  // 解析目标平台
  let targets;
  if (platformRows && platformRows.length) {
    const set = new Set(platformRows.map(Number));
    targets = wb.platforms.filter((p) => set.has(p.row));
  } else if (t.relatedPlatforms === '全部') {
    targets = wb.platforms.filter((p) => p.enabled);
  } else {
    const rel = t.relatedPlatforms;
    targets = wb.platforms.filter((p) => p.enabled && rel.includes(p.name));
  }

  if (!targets.length) {
    globalErrors.push(`类型「${type}」没有匹配到任何启用中的平台（检查「关联平台」或平台「启用」列）`);
    return { items: [], globalErrors };
  }

  const items = [];
  for (const p of targets) {
    const errors = [];
    const warnings = [];

    // 变量：内置 < 平台字段(含客户姓名/扩展列) < 平台名称 < 发送时覆盖
    const cust = (overrides && overrides['客户姓名']) || p.vars['客户姓名'] || p.vars['对接联系人'] || '';
    const vars = {
      ...base,
      ...p.vars,
      平台名称: p.name,
      客户姓名: cust,
      ...(overrides || {}),
    };

    // ---- 主题 ----
    let subject = '';
    if (!t.subjectTemplate) {
      errors.push(`类型「${type}」的「主题格式」为空`);
    } else {
      const out = render(t.subjectTemplate, vars);
      subject = out.text;
      if (out.missing.length) {
        errors.push(`主题里的变量无值 → ${out.missing.map((v) => `{${v}}`).join(' ')}`);
      }
    }
    if (subject.includes('\n')) {
      errors.push(`主题不能含换行`);
      subject = subject.replace(/\s*\n\s*/g, ' ');
    }

    // ---- 正文 ----
    let body = '';
    let html = '';
    if (!t.bodyTemplate || !t.bodyTemplate.trim()) {
      errors.push(`类型「${type}」的「正文MD」是空的`);
    } else {
      const out = render(t.bodyTemplate, vars);
      body = out.text;
      html = renderMd(body, { email: true });
      if (out.missing.length) {
        errors.push(`正文里的变量无值 → ${out.missing.map((v) => `{${v}}`).join(' ')}`);
      }
    }

    // ---- 收件人 ----
    const to = splitAddresses(p.to);
    const cc = splitAddresses(p.cc);
    const bcc = splitAddresses(p.bcc);
    if (!to.length) errors.push(`平台「${p.name}」收件邮箱为空`);
    for (const addr of [...to, ...cc, ...bcc]) {
      if (!EMAIL_RE.test(addr)) errors.push(`平台「${p.name}」邮箱格式不合法 → ${addr}`);
    }

    // ---- 附件 ----
    const attachments = [];
    for (const name of p.attachments) {
      if (name.includes(',')) warnings.push(`附件名含英文逗号可能引发问题：${name}`);
      const abs = resolveAttachment(name, attachDir);
      if (!fs.existsSync(abs)) {
        errors.push(`平台「${p.name}」附件不存在 → ${abs}`);
      } else if (fs.statSync(abs).isDirectory()) {
        errors.push(`平台「${p.name}」附件是目录不是文件 → ${abs}`);
      }
      attachments.push({ name: path.basename(abs), path: abs, raw: name });
    }
    if (!attachments.length) warnings.push(`平台「${p.name}」没有配置附件`);

    items.push({
      type,
      platform: p.name,
      customer: cust,
      recipientName: p.name,
      senderName: t.senderName,
      to,
      cc,
      bcc,
      subject,
      body,
      html,
      attachments,
      errors,
      warnings,
      row: p.row,
      key: `${type}\u0000${p.name}`,
    });
  }

  return { items, globalErrors };
}

module.exports = { buildPlan, splitAddresses };
