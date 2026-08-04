'use strict';

/**
 * 读取 SMTP 配置。
 * - 便携包：用 MAILER_DATA_DIR 环境变量指向的 data/.env（凭据随应用走，Windows 也放得对）
 * - 本地开发：回退 ~/.config/mail-skills/.env（与 imap-smtp-email 技能共用）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDERS = {
  '163': { host: 'smtp.163.com', port: 465, secure: true },
  'vip.163': { host: 'smtp.vip.163.com', port: 465, secure: true },
  '126': { host: 'smtp.126.com', port: 465, secure: true },
  'vip.126': { host: 'smtp.vip.126.com', port: 465, secure: true },
  '188': { host: 'smtp.188.com', port: 465, secure: true },
  'vip.188': { host: 'smtp.vip.188.com', port: 465, secure: true },
  yeah: { host: 'smtp.yeah.net', port: 465, secure: true },
  qq: { host: 'smtp.qq.com', port: 587, secure: false },
  'exmail.qq': { host: 'smtp.exmail.qq.com', port: 465, secure: true },
  gmail: { host: 'smtp.gmail.com', port: 587, secure: false },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false },
};

const DATA_DIR = process.env.MAILER_DATA_DIR || path.join(__dirname, '..', 'data');
const LOCAL_ENV = path.join(DATA_DIR, '.env');
const CONFIG_CANDIDATES = [
  LOCAL_ENV,
  path.join(os.homedir(), '.config', 'mail-skills', '.env'),
  path.join(os.homedir(), '.config', 'imap-smtp-email', '.env'),
];

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function findConfigFile() {
  for (const p of CONFIG_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {string} [account] 账户名（对应 .env 里的大写前缀）；不传则用默认账户
 */
function loadSmtpConfig(account) {
  const configPath = findConfigFile();
  if (!configPath) {
    throw new Error(
      '还没配置发件账号。在 mailer 目录下运行：\n' +
        '  node tools/set-account.js --provider 126 --user 你的邮箱@126.com --pass 授权码\n' +
        '（163 邮箱把 --provider 换成 163；授权码在网页版邮箱 设置→POP3/SMTP/IMAP 里生成）'
    );
  }

  const env = parseEnv(fs.readFileSync(configPath, 'utf8'));
  const prefix = account ? `${account.toUpperCase()}_` : '';
  const get = (key) => env[prefix + key] || '';

  const providerKey = (get('PROVIDER') || '').toLowerCase();
  const preset = PROVIDERS[providerKey] || null;

  const host = get('SMTP_HOST') || (preset && preset.host) || '';
  const port = Number(get('SMTP_PORT') || (preset && preset.port) || 465);
  const secureRaw = get('SMTP_SECURE');
  const secure = secureRaw
    ? secureRaw.toLowerCase() === 'true'
    : preset
      ? preset.secure
      : port === 465;

  const user = get('USERNAME') || get('SMTP_USER') || '';
  const pass = get('PASSWORD') || get('SMTP_PASS') || '';
  const from = get('SMTP_FROM') || user;

  if (!host || !user || !pass) {
    throw new Error(
      `配置不完整（${configPath}${account ? `，账户 ${account}` : ''}）：` +
        `缺少 ${!host ? 'SMTP_HOST/PROVIDER ' : ''}${!user ? 'USERNAME ' : ''}${!pass ? 'PASSWORD' : ''}`.trim()
    );
  }

  const rejectRaw = get('SMTP_REJECT_UNAUTHORIZED');

  return {
    configPath,
    host,
    port,
    secure,
    user,
    pass,
    from,
    rejectUnauthorized: rejectRaw ? rejectRaw.toLowerCase() !== 'false' : true,
    allowedReadDirs: (env.ALLOWED_READ_DIRS || '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => path.resolve(d.replace(/^~/, os.homedir()))),
  };
}

module.exports = { loadSmtpConfig, findConfigFile, PROVIDERS, LOCAL_ENV };
