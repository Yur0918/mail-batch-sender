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

  // 展开：把「一个平台多个收件人」拆成「每收件人单独一封」。
  // 原因：发件方 SMTP 中继常对「一封邮件多个收件人」整体判违规（反垃圾 / 收件人过多），
  // 导致整封失败；拆开单独发可规避，且失败能精确到单个收件人而非整平台。
  const tasks = [];
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    const toList = Array.isArray(it.to) ? it.to : it.to ? [it.to] : [];
    if (!toList.length) {
      const rec = { ok: false, to: '', error: '无收件人' };
      results.push(rec);
      if (onEach) onEach({ index: idx, ok: false, item: it, error: new Error('无收件人') });
      continue;
    }
    toList.forEach((addr, k) => {
      tasks.push({ idx, it, addr, isMulti: toList.length > 1, k });
    });
  }

  for (let t = 0; t < tasks.length; t++) {
    const { idx, it, addr, isMulti, k } = tasks[t];
    const mail = {
      from: formatAddress(it.senderName, smtp.from),
      to: addr,
      subject: it.subject,
      text: it.body,
      attachments: (it.attachments || []).map((a) => ({ filename: a.name, path: a.path })),
    };
    // 多收件人拆分时，cc/bcc 只附在第一封，避免收件人重复收到多份抄送
    if (!isMulti || k === 0) {
      if (it.cc && it.cc.length) mail.cc = it.cc.join(', ');
      if (it.bcc && it.bcc.length) mail.bcc = it.bcc.join(', ');
    }
    if (it.html) mail.html = it.html;

    try {
      const info = await transporter.sendMail(mail);
      const rec = { ok: true, to: addr, messageId: info.messageId };
      results.push(rec);
      if (onEach) onEach({ index: idx, ok: true, item: it, info, to: addr });
    } catch (err) {
      const rec = { ok: false, to: addr, error: err.message };
      results.push(rec);
      if (onEach) onEach({ index: idx, ok: false, item: it, error: err, to: addr });
      if (/554|DT:SPM|频率|too many/i.test(err.message)) {
        await sleep(30000);
      }
    }
    if (t < tasks.length - 1) await sleep(interval);
  }

  transporter.close();
  return results;
}

module.exports = { sendItems, createTransport, explainSmtpError, formatAddress };
