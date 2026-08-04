'use strict';

/**
 * 封装 nodemailer 发送逻辑，供 web server 复用（与 send.js CLI 行为一致）。
 */

const nodemailer = require('nodemailer');

function formatAddress(name, email) {
  if (!name) return email;
  return `"${String(name).replace(/"/g, '')}" <${email}>`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const NETEASE_HOSTS = /(163|126|188|yeah)\./;

/** 把 SMTP 报错翻译成人话（与 send.js 保持一致） */
function explainSmtpError(message, host) {
  const tips = [];
  const m = String(message);
  const isNetease = NETEASE_HOSTS.test(host || '');

  if (/535|auth|authenticat/i.test(m)) {
    if (isNetease) {
      tips.push('网易邮箱必须用「授权码」，不能用登录密码。');
      tips.push('网页版 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 新增授权密码。');
      tips.push('开启服务时如果提示需要手机短信验证，必须走完，否则授权码不生效。');
    } else {
      tips.push('认证失败：检查账号与密码/授权码是否正确。');
    }
  }
  if (/554|DT:SPM|spam|垃圾/i.test(m)) {
    tips.push('被反垃圾拦截。加大发送间隔，并让每封内容有差异（收件方名称、工单号等）。');
    if (isNetease) tips.push('网易对「短时间内多封内容完全相同」的信特别敏感。');
  }
  if (/550|不在.*白名单|not in whitelist/i.test(m)) {
    tips.push('发件人被拒。确认 SMTP_FROM 与登录账号完全一致——网易不允许伪造发件地址。');
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(m)) {
    tips.push('网络不通：检查代理/防火墙是否放行端口，或换 465 端口 + SMTP_SECURE=true。');
  }
  if (/频率|too many|rate/i.test(m)) {
    tips.push('触发发信频率限制。普通账号日发信量有上限，建议分批跨天发。');
  }
  return tips;
}

function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
    tls: { rejectUnauthorized: smtp.rejectUnauthorized },
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  });
}

/**
 * 逐封发送，带间隔与限流暂停。
 * @param {object[]} items  buildPlan 的产物（含 to/cc/bcc/subject/body/html/attachments/senderName）
 * @param {object} opts { smtp, interval(ms), onEach }
 */
async function sendItems(items, opts = {}) {
  const { smtp, interval = 3000, onEach } = opts;
  const transporter = createTransport(smtp);
  const results = [];

  try {
    await transporter.verify();
  } catch (err) {
    transporter.close();
    throw err;
  }

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const mail = {
      from: formatAddress(it.senderName, smtp.from),
      to: Array.isArray(it.to) ? it.to.join(', ') : it.to,
      subject: it.subject,
      text: it.body,
      attachments: (it.attachments || []).map((a) => ({ filename: a.name, path: a.path })),
    };
    if (it.cc && it.cc.length) mail.cc = it.cc.join(', ');
    if (it.bcc && it.bcc.length) mail.bcc = it.bcc.join(', ');
    if (it.html) mail.html = it.html;

    try {
      const info = await transporter.sendMail(mail);
      const rec = { ok: true, to: mail.to, messageId: info.messageId };
      results.push(rec);
      if (onEach) onEach({ index: i, ok: true, item: it, info });
    } catch (err) {
      const rec = { ok: false, to: mail.to, error: err.message };
      results.push(rec);
      if (onEach) onEach({ index: i, ok: false, item: it, error: err });
      if (/554|DT:SPM|频率|too many/i.test(err.message)) {
        await sleep(30000);
      }
    }
    if (i < items.length - 1) await sleep(interval);
  }

  transporter.close();
  return results;
}

module.exports = { sendItems, createTransport, explainSmtpError, formatAddress };
