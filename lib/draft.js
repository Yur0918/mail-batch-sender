'use strict';

/**
 * 草稿（上传邮件）编译层。
 *
 * 与 buildPlan 的「模板 × 平台」模型不同，草稿流里：
 *   - 正文来自经办上传的文件（.md/.txt/.html），或手动粘贴的文本
 *   - 平台来自文件名解析 / 经办下拉选择（对应配置里的收件邮箱）
 *   - 客户姓名来自文件名解析 / 经办填写（作为 {对接联系人} 变量 / 标签）
 *   - 邮件类型决定「主题格式」
 *
 * compileJob 把一条草稿编译成与 mailer.sendItems 兼容的 item，并做全量校验。
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

/** 读取正文文件，按扩展名决定 HTML / 纯文本；二进制文件返回空正文。 */
function readBody(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');
  // 安全兜底：含空字节或大量控制符时视为二进制，不可读作正文
  if (raw.includes('\u0000') || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw.slice(0, 2048))) {
    return { body: '', html: '' };
  }
  if (ext === '.html' || ext === '.htm') {
    return { body: raw, html: raw };
  }
  if (ext === '.md' || ext === '.markdown') {
    return { body: raw, html: renderMd(raw, { email: true }) };
  }
  // .txt 及其它：当作纯文本
  return { body: raw, html: '' };
}

/**
 * @param {object} job { type, platform, customer, bodyFileId?, body?, attachments?:[fileId] }
 * @param {object} ctx { wb, uploadDir, attachDir, now }
 */
function compileJob(job, ctx) {
  const { wb, uploadDir, attachDir, now } = ctx;
  const errors = [];
  const warnings = [];
  const base = builtinVars(now || new Date());

  const typeName = (job.type || '').trim();
  const t = wb.types.get(typeName);
  if (!t) errors.push(`类型「${typeName || '(空)'}」在配置中不存在`);

  const platformName = (job.platform || '').trim();
  const p = platformName ? wb.platforms.find((x) => x.name === platformName) : null;
  if (!p) errors.push(`平台「${platformName || '(空)'}」在配置中找不到收件邮箱`);

  const customer = (job.customer || '').trim();

  // 公共变量（主题/模板正文都会用到）
  const vars = {
    ...base,
    ...(p ? p.vars : {}),
    平台名称: p ? p.name : '',
    客户姓名: customer || (p ? p.vars['客户姓名'] || p.vars['对接联系人'] || '' : ''),
  };

  // ---- 正文 ----
  let body = '';
  let html = '';
  if (job.bodyFileId) {
    const fp = path.join(uploadDir, path.basename(job.bodyFileId));
    if (!fs.existsSync(fp)) {
      errors.push(`正文文件丢失：${job.bodyFileId}`);
    } else {
      const r = readBody(fp);
      body = r.body;
      html = r.html;
      if (!body && !html) warnings.push(`正文文件无可读文本内容，已使用模板正文兜底`);
    }
  }
  // 手动输入/编辑过的正文：优先级低于上传文件、高于模板兜底
  if (!body && !html && job.body) {
    body = job.body;
    html = renderMd(body, { email: true });
  }
  // 无上传正文、无手动正文时，fallback 到类型模板正文
  if (!body && !html && t && t.bodyTemplate && t.bodyTemplate.trim()) {
    const out = render(t.bodyTemplate, vars);
    body = out.text;
    html = renderMd(body, { email: true });
    if (out.missing.length) {
      errors.push(`正文变量缺值 → ${out.missing.map((v) => `{${v}}`).join(' ')}`);
    }
  }
  if (!body && !html) {
    errors.push('缺少邮件正文');
  }

  // ---- 主题（来自类型的主题格式） ----
  let subject = '';
  if (t) {
    if (!t.subjectTemplate) {
      errors.push(`类型「${typeName}」缺少主题格式`);
    } else {
      const out = render(t.subjectTemplate, vars);
      subject = out.text;
      if (out.missing.length) {
        errors.push(`主题变量缺值 → ${out.missing.map((v) => `{${v}}`).join(' ')}`);
      }
    }
  }

  // ---- 收件人 ----
  let to = [];
  let cc = [];
  let bcc = [];
  if (p) {
    to = splitAddresses(p.to);
    cc = splitAddresses(p.cc);
    bcc = splitAddresses(p.bcc);
    if (!to.length) errors.push(`平台「${p.name}」收件邮箱为空`);
    for (const a of [...to, ...cc, ...bcc]) {
      if (!EMAIL_RE.test(a)) errors.push(`平台「${p.name}」邮箱格式不合法 → ${a}`);
    }
  }

  // ---- 附件：平台默认附件（来自配置）+ 本条目上传的附件 ----
  const attachments = [];
  if (p) {
    for (const name of p.attachments) {
      const abs = path.isAbsolute(name) ? name : path.join(attachDir, name);
      const rp = path.resolve(abs);
      if (!fs.existsSync(rp)) {
        errors.push(`平台「${p.name}」默认附件不存在 → ${rp}`);
      } else if (fs.statSync(rp).isDirectory()) {
        errors.push(`平台「${p.name}」默认附件是目录 → ${rp}`);
      } else {
        attachments.push({ name: path.basename(rp), path: rp, raw: name });
      }
    }
  }
  for (const a of job.attachments || []) {
    const fid = (typeof a === 'string') ? a : a.id;
    const origName = (typeof a === 'object' && a.name) ? a.name : null;
    const fp = path.join(uploadDir, path.basename(fid));
    if (!fs.existsSync(fp)) {
      errors.push(`附件丢失：${fid}`);
      continue;
    }
    attachments.push({ name: origName || path.basename(fp), path: fp, raw: fid });
  }
  if (!attachments.length && p && !p.attachments.length) {
    warnings.push(`平台「${p.name}」没有配置附件`);
  }

  return {
    type: typeName,
    platform: p ? p.name : platformName,
    customer,
    recipientName: customer || (p ? p.name : ''),
    senderName: t ? t.senderName : '',
    to,
    cc,
    bcc,
    subject,
    body,
    html,
    attachments,
    errors,
    warnings,
  };
}

module.exports = { compileJob, readBody, splitAddresses };
