#!/usr/bin/env node
'use strict';

/**
 * 邮箱批量发件工具（163 / 126 / yeah / QQ / Outlook 等）
 *
 *   node send.js preview  [--type 监管件] [--全文]
 *   node send.js send     [--type 监管件] --confirm [--interval 3] [--retry-failed]
 *   node send.js test     --to a@qq.com[,b@163.com] [--count 3]
 *   node send.js account
 *   node send.js types
 *
 * 多对多模型：一个「类型」(邮件模板) 发给其「关联平台」(多个收件人)。
 * 设计原则：默认永不发信。send 必须显式带 --confirm，且任一校验失败则整批拒发。
 */

const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const { loadSmtpConfig } = require('./lib/config');
const { loadWorkbook } = require('./lib/workbook');
const { buildPlan } = require('./lib/plan');
const { Logger, readFailedKeys } = require('./lib/logger');

const ROOT = __dirname;
const DEFAULT_WORKBOOK = path.join(ROOT, 'config', '邮件配置.xlsx');
const ATTACH_DIR = path.join(ROOT, 'attachments');
const LOG_DIR = path.join(ROOT, 'logs');

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function parseArgs(argv) {
  const command = argv[2] || 'preview';
  const opts = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { command, opts };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatAddress(name, email) {
  if (!name) return email;
  return `"${String(name).replace(/"/g, '')}" <${email}>`;
}

const NETEASE_HOSTS = /(163|126|188|yeah)\./;

/** 把 SMTP 报错翻译成人话 */
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
    tips.push('被反垃圾拦截。加大 --interval，并让每封内容有差异（收件方名称、工单号等）。');
    if (isNetease) tips.push('网易对「短时间内多封内容完全相同」的信特别敏感。');
  }
  if (/550|不在.*白名单|not in whitelist/i.test(m)) {
    tips.push('发件人被拒。确认 SMTP_FROM 与登录账号完全一致——网易不允许伪造发件地址。');
  }
  if (/timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND/i.test(m)) {
    tips.push('网络不通：检查代理/防火墙是否放行 465 端口，或换 587 端口 + SMTP_SECURE=false。');
  }
  if (/频率|too many|rate/i.test(m)) {
    tips.push('触发发信频率限制。普通网易账号日发信量有上限，建议分批跨天发。');
  }
  return tips;
}

function printSmtpError(err, host) {
  console.log(`${C.red}SMTP 失败：${err.message}${C.reset}`);
  for (const t of explainSmtpError(err.message, host)) {
    console.log(`${C.yellow}  · ${t}${C.reset}`);
  }
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

function printItem(item, index, total, showFull) {
  const status = item.errors.length ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
  console.log(
    `${status} ${C.bold}[${index + 1}/${total}]${C.reset} ` +
      `${C.cyan}${item.type}${C.reset} · ${item.platform || '(未命名)'} ` +
      `${C.dim}(平台表第 ${item.row} 行)${C.reset}`
  );
  console.log(`    收件人 : ${item.to.join(', ') || C.red + '(空)' + C.reset}`);
  if (item.cc.length) console.log(`    抄送   : ${item.cc.join(', ')}`);
  if (item.bcc.length) console.log(`    密送   : ${item.bcc.join(', ')}`);
  console.log(`    主题   : ${item.subject || C.red + '(空)' + C.reset}`);
  console.log(
    `    附件   : ${
      item.attachments.length
        ? item.attachments.map((a) => a.name).join(' | ')
        : C.dim + '无' + C.reset
    }`
  );

  const bodyLines = item.body.split('\n');
  if (showFull) {
    console.log(`    正文   :`);
    for (const line of bodyLines) console.log(`      ${C.dim}${line}${C.reset}`);
  } else {
    const preview = bodyLines.slice(0, 3);
    console.log(`    正文   : ${C.dim}${preview.join(' ⏎ ')}${C.reset}`);
    if (bodyLines.length > 3) {
      console.log(`             ${C.dim}…共 ${bodyLines.length} 行（加 --全文 查看）${C.reset}`);
    }
  }
  for (const w of item.warnings) console.log(`    ${C.yellow}⚠ ${w}${C.reset}`);
  for (const e of item.errors) console.log(`    ${C.red}✗ ${e}${C.reset}`);
  console.log('');
}

async function loadAll(opts) {
  const wbPath = opts.配置 || opts.config || DEFAULT_WORKBOOK;
  if (!fs.existsSync(wbPath)) {
    throw new Error(`找不到配置文件：${wbPath}`);
  }
  const wb = await loadWorkbook(wbPath);
  const type = opts.type || opts.渠道 || opts.channel;
  if (!type) throw new Error('预览/发送需要指定类型：--type 监管件');
  const plan = buildPlan(wb, { type, attachDir: ATTACH_DIR });
  return { wb, plan, wbPath, type };
}

async function cmdTypes(opts) {
  const { wb } = await loadAll(opts);
  console.log(`\n${C.bold}已配置类型（邮件模板）${C.reset}\n`);
  for (const t of wb.types.values()) {
    const rel =
      t.relatedPlatforms === '全部'
        ? '全部启用平台'
        : t.relatedPlatforms.join(', ');
    const bodyLines = (t.bodyTemplate || '').split('\n').filter((x) => x.trim()).length;
    console.log(`  ${C.cyan}${t.name}${C.reset}`);
    console.log(`    主题格式 : ${t.subjectTemplate || C.red + '(空)' + C.reset}`);
    console.log(`    正文     : ${bodyLines} 行　${C.dim}(${bodyLines ? '已填' : '空'})${C.reset}`);
    console.log(`    发件显示名 : ${t.senderName || C.dim + '(用默认)' + C.reset}`);
    console.log(`    关联平台 : ${rel}\n`);
  }
}

async function cmdPreview(opts) {
  const { plan, wbPath, type } = await loadAll(opts);
  const showFull = Boolean(opts.全文 || opts.full);

  console.log(`\n${C.bold}配置文件${C.reset} ${wbPath}`);
  console.log(`${C.bold}类型${C.reset} ${type}\n`);

  for (const e of plan.globalErrors) console.log(`${C.red}✗ ${e}${C.reset}`);

  if (!plan.items.length) {
    console.log(`${C.yellow}没有匹配到任何待发邮件。${C.reset}\n`);
    return { plan, ok: false };
  }

  plan.items.forEach((item, i) => printItem(item, i, plan.items.length, showFull));

  const bad = plan.items.filter((i) => i.errors.length);
  const warn = plan.items.filter((i) => !i.errors.length && i.warnings.length);
  console.log('─'.repeat(60));
  console.log(
    `共 ${C.bold}${plan.items.length}${C.reset} 封　` +
      `${C.green}通过 ${plan.items.length - bad.length}${C.reset}　` +
      `${C.red}错误 ${bad.length}${C.reset}　` +
      `${C.yellow}警告 ${warn.length}${C.reset}`
  );

  const ok = bad.length === 0 && plan.globalErrors.length === 0;
  if (!ok) {
    console.log(`\n${C.red}${C.bold}存在错误，send 会拒绝执行。请先修好上面的问题。${C.reset}\n`);
  } else {
    console.log(
      `\n${C.green}校验全部通过。${C.reset}确认无误后执行：\n` +
        `  ${C.bold}node send.js send --type ${type} --confirm${C.reset}\n`
    );
  }
  return { plan, ok };
}

async function cmdAccount(opts) {
  const smtp = loadSmtpConfig(opts.account);
  console.log(`\n${C.bold}当前发件账号${C.reset}`);
  console.log(`  配置文件 : ${smtp.configPath}`);
  console.log(`  SMTP     : ${smtp.host}:${smtp.port} (secure=${smtp.secure})`);
  console.log(`  账号     : ${smtp.user}`);
  console.log(`  发件地址 : ${smtp.from}`);
  console.log(`  密码     : **** (${smtp.pass.length} 位)`);

  const transporter = createTransport(smtp);
  try {
    await transporter.verify();
    console.log(`\n${C.green}✓ 连接与认证均正常，可以发信。${C.reset}\n`);
  } catch (err) {
    console.log('');
    printSmtpError(err, smtp.host);
    console.log('');
    process.exitCode = 1;
  } finally {
    transporter.close();
  }
}

async function cmdTest(opts) {
  const raw = opts.to || opts.收件人;
  if (!raw || raw === true) {
    console.log(
      `\n${C.red}需要 --to 指定收件邮箱。${C.reset}\n` +
        `  node send.js test --to a@qq.com\n` +
        `  node send.js test --to a@qq.com,b@163.com --count 3\n`
    );
    process.exitCode = 1;
    return;
  }

  const recipients = String(raw).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const count = Math.max(1, Number(opts.count || 1));
  const interval = Number(opts.interval || 3) * 1000;
  const withAttach = Boolean(opts.附件 || opts.attach);

  const smtp = loadSmtpConfig(opts.account);
  const total = recipients.length * count;

  console.log(`\n${C.bold}连通性测试${C.reset}`);
  console.log(`  发件账号 : ${smtp.user} @ ${smtp.host}:${smtp.port}`);
  console.log(`  收件人   : ${recipients.join(', ')}`);
  console.log(`  每人封数 : ${count}　总计 ${C.bold}${total}${C.reset} 封　间隔 ${interval / 1000}s`);
  console.log(`  测试附件 : ${withAttach ? '带' : '不带'}\n`);

  let attachments;
  if (withAttach) {
    const p = path.join(LOG_DIR, '测试附件.txt');
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(p, `这是一个测试附件\n生成时间：${new Date().toLocaleString('zh-CN')}\n`);
    attachments = [{ filename: '测试附件.txt', path: p }];
  }

  const transporter = createTransport(smtp);
  try {
    await transporter.verify();
    console.log(`${C.green}✓ SMTP 连接与认证正常${C.reset}\n`);
  } catch (err) {
    printSmtpError(err, smtp.host);
    console.log('');
    transporter.close();
    process.exitCode = 1;
    return;
  }

  let okCount = 0;
  let failCount = 0;
  let n = 0;

  for (let c = 1; c <= count; c++) {
    for (const to of recipients) {
      n++;
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
      // 每封内容都带序号+时间戳，避免网易把「多封完全相同」判成垃圾邮件
      const subject = `【测试】批量发件连通性验证 #${n} (${stamp})`;
      const body = [
        `这是第 ${n}/${total} 封测试邮件，用于验证批量发件链路。`,
        '',
        `发件账号：${smtp.user}`,
        `SMTP    ：${smtp.host}:${smtp.port}`,
        `收件人  ：${to}`,
        `发送时间：${stamp}`,
        `发送间隔：${interval / 1000} 秒`,
        '',
        '如果你收到这封信，说明账号配置、TLS 连接、认证、投递全部正常。',
        '收到后请检查：1) 是否进了垃圾箱  2) 中文主题和正文有没有乱码  3) 附件能否打开。',
      ].join('\n');

      try {
        const info = await transporter.sendMail({
          from: formatAddress(opts['发件名'] || opts.name || '', smtp.from),
          to,
          subject,
          text: body,
          attachments,
        });
        okCount++;
        console.log(`${C.green}✓${C.reset} [${n}/${total}] → ${to}  ${C.dim}${info.messageId}${C.reset}`);
      } catch (err) {
        failCount++;
        console.log(`${C.red}✗${C.reset} [${n}/${total}] → ${to}`);
        printSmtpError(err, smtp.host);
        if (/554|DT:SPM|频率|too many/i.test(err.message)) {
          console.log(`${C.yellow}  暂停 30 秒后继续…${C.reset}`);
          await sleep(30000);
        }
      }

      if (n < total) await sleep(interval);
    }
  }

  transporter.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`${C.green}成功 ${okCount}${C.reset}　${C.red}失败 ${failCount}${C.reset}`);
  if (okCount && !failCount) {
    console.log(
      `\n${C.green}链路通了。${C.reset}接下来填 ${C.bold}config/邮件配置.xlsx${C.reset}，` +
        `然后 ${C.bold}node send.js preview --type 监管件${C.reset}。\n`
    );
  } else {
    console.log('');
  }
}

async function cmdSend(opts) {
  if (!opts.confirm) {
    console.log(
      `\n${C.red}${C.bold}拒绝执行：send 必须显式加 --confirm。${C.reset}\n` +
        `先跑 ${C.bold}node send.js preview --type ${opts.type || '监管件'}${C.reset} 核对收件人和附件。\n`
    );
    process.exitCode = 1;
    return;
  }

  const smtp = loadSmtpConfig(opts.account);
  const { plan, wbPath, type } = await loadAll(opts);

  if (plan.globalErrors.length || plan.items.some((i) => i.errors.length)) {
    console.log(`\n${C.red}${C.bold}校验未通过，整批拒发。${C.reset}`);
    for (const e of plan.globalErrors) console.log(`  ${C.red}✗ ${e}${C.reset}`);
    for (const item of plan.items) {
      for (const e of item.errors) console.log(`  ${C.red}✗ ${e}${C.reset}`);
    }
    console.log(`\n跑 ${C.bold}node send.js preview --type ${type}${C.reset} 看完整报告。\n`);
    process.exitCode = 1;
    return;
  }

  let items = plan.items;
  if (opts['retry-failed']) {
    const failed = readFailedKeys(LOG_DIR);
    items = items.filter((i) => failed.has(i.key));
    if (!items.length) {
      console.log(`\n${C.green}最近一次日志里没有失败记录，无需重发。${C.reset}\n`);
      return;
    }
    console.log(`\n${C.yellow}仅重发上次失败的 ${items.length} 封${C.reset}`);
  }

  if (!items.length) {
    console.log(`\n${C.yellow}没有待发邮件。${C.reset}\n`);
    return;
  }

  const interval = Number(opts.interval || 3) * 1000;

  const transporter = createTransport(smtp);

  console.log(`\n${C.bold}配置文件${C.reset} ${wbPath}`);
  console.log(`${C.bold}发件账号${C.reset} ${smtp.user} @ ${smtp.host}:${smtp.port}`);
  console.log(`${C.bold}类型${C.reset} ${type}`);
  console.log(`${C.bold}发送间隔${C.reset} ${interval / 1000}s`);
  console.log(`${C.bold}待发数量${C.reset} ${items.length}\n`);

  try {
    await transporter.verify();
    console.log(`${C.green}SMTP 连接正常${C.reset}\n`);
  } catch (err) {
    printSmtpError(err, smtp.host);
    transporter.close();
    process.exitCode = 1;
    return;
  }

  const logger = new Logger(LOG_DIR);
  let okCount = 0;
  let failCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prefix = `[${i + 1}/${items.length}] ${item.type} · ${item.platform}`;
    try {
      const info = await transporter.sendMail({
        from: formatAddress(item.senderName, smtp.from),
        to: item.to.join(', '),
        cc: item.cc.length ? item.cc.join(', ') : undefined,
        bcc: item.bcc.length ? item.bcc.join(', ') : undefined,
        subject: item.subject,
        text: item.body,
        html: item.html,
        attachments: item.attachments.map((a) => ({ filename: a.name, path: a.path })),
      });
      okCount++;
      console.log(`${C.green}✓${C.reset} ${prefix} → ${item.to.join(', ')}`);
      logger.append({
        type: item.type,
        platform: item.platform,
        customer: item.customer || '',
        to: item.to.join(';'),
        cc: item.cc.join(';'),
        subject: item.subject,
        attachments: item.attachments.map((a) => a.name),
        status: '成功',
        detail: info.messageId,
        row: item.row,
      });
    } catch (err) {
      failCount++;
      console.log(`${C.red}✗${C.reset} ${prefix} → ${item.to.join(', ')}  ${C.red}${err.message}${C.reset}`);
      logger.append({
        type: item.type,
        platform: item.platform,
        customer: item.customer || '',
        to: item.to.join(';'),
        cc: item.cc.join(';'),
        subject: item.subject,
        attachments: item.attachments.map((a) => a.name),
        status: '失败',
        detail: err.message,
        row: item.row,
      });
      if (/554|DT:SPM|频率|too many/i.test(err.message)) {
        console.log(
          `${C.yellow}检测到疑似限流/反垃圾拦截，暂停 30 秒后继续。建议加大 --interval。${C.reset}`
        );
        await sleep(30000);
      }
    }

    if (i < items.length - 1) await sleep(interval);
  }

  transporter.close();
  console.log('\n' + '─'.repeat(60));
  console.log(`${C.green}成功 ${okCount}${C.reset}　${C.red}失败 ${failCount}${C.reset}`);
  console.log(`日志：${logger.file}`);
  if (failCount) {
    console.log(`\n重发失败项：${C.bold}node send.js send --retry-failed --confirm${C.reset}`);
  }
  console.log('');
}

function usage() {
  console.log(`
邮箱批量发件工具（163 / 126 / yeah / QQ / Outlook…）

  node send.js account                            查看当前账号并测试连接（不发信）
  node send.js test --to a@qq.com [--count 3]     发测试信验证链路
  node send.js preview  [--type 监管件] [--全文]  预览校验，绝不发信（默认命令）
  node send.js send     [--type 监管件] --confirm 真实发送
  node send.js types                            查看已配置的邮件类型

test 参数
  --to <邮箱[,邮箱]>   收件人，必填
  --count <N>          给每个收件人各发 N 封，默认 1（用来测批量节流）
  --附件               附带一个自动生成的测试附件
  --发件名 <名称>      发件人显示名

发送可选参数
  --interval <秒>     每封间隔，默认 3
  --retry-failed      只重发最近一次日志里失败的
  --account <名称>    使用 .env 里的指定账户（多账号时）
  --配置 <路径>        指定其他配置工作簿

首次配置账号
  node tools/set-account.js --provider qq --user me@qq.com --pass 授权码
`);
}

async function main() {
  const { command, opts } = parseArgs(process.argv);
  try {
    switch (command) {
      case 'preview':
        await cmdPreview(opts);
        break;
      case 'send':
        await cmdSend(opts);
        break;
      case 'test':
        await cmdTest(opts);
        break;
      case 'account':
        await cmdAccount(opts);
        break;
      case 'types':
        await cmdTypes(opts);
        break;
      case 'help':
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.log(`未知命令：${command}`);
        usage();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\n${C.red}错误：${err.message}${C.reset}\n`);
    process.exitCode = 1;
  }
}

main();
