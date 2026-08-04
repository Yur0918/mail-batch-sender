'use strict';

/**
 * SMTP 账号的读写（与 tools/set-account.js、web server 共用）。
 * 便携包（设了 MAILER_DATA_DIR）把凭据写在应用目录的 data/.env；
 * 本地开发回退 ~/.config/mail-skills/.env（权限 600）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDERS, LOCAL_ENV } = require('./config');

// 便携模式（设了 MAILER_DATA_DIR）或本地 data/.env 已存在时，凭据写在应用目录内；
// 否则回退 ~/.config/mail-skills/.env，保持本地开发兼容。
const FALLBACK_FILE = path.join(os.homedir(), '.config', 'mail-skills', '.env');
const CONFIG_FILE = (process.env.MAILER_DATA_DIR || (LOCAL_ENV && fs.existsSync(LOCAL_ENV))) ? LOCAL_ENV : FALLBACK_FILE;
const CONFIG_DIR = path.dirname(CONFIG_FILE);

function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
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

function readRaw() {
  return fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, 'utf8') : '';
}

function readMasked() {
  const text = readRaw();
  if (!text) return null;
  const env = parseEnv(text);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = /PASS/.test(k) ? '****' : v;
  }
  return out;
}

function upsert(text, key, value) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${key}=`);
  let found = false;
  const out = lines.map((l) => {
    if (re.test(l.trim())) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) out.push(`${key}=${value}`);
  return out.join('\n');
}

/**
 * 写入/更新一个 SMTP 账号。
 * @returns {{ warning?: string, provider, host, port, secure, user, account }}
 */
function writeAccount({ provider, user, pass, fromName, account }) {
  const key = String(provider).toLowerCase();
  if (!PROVIDERS[key]) {
    const err = new Error(`未知服务商「${provider}」。支持：${Object.keys(PROVIDERS).join(', ')}`);
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  const preset = PROVIDERS[key];
  const prefix = account && account !== true ? `${String(account).toUpperCase()}_` : '';

  const domain = String(user).split('@')[1] || '';
  let warning = '';
  if (domain && !preset.host.includes(domain.replace(/^mail\./, ''))) {
    warning = `邮箱域名「${domain}」与服务商预设「${preset.host}」不匹配，请确认。`;
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let text = readRaw();
  if (text && !text.endsWith('\n')) text += '\n';

  text = upsert(text, `${prefix}PROVIDER`, key);
  text = upsert(text, `${prefix}SMTP_HOST`, preset.host);
  text = upsert(text, `${prefix}SMTP_PORT`, String(preset.port));
  text = upsert(text, `${prefix}SMTP_SECURE`, String(preset.secure));
  text = upsert(text, `${prefix}USERNAME`, user);
  text = upsert(text, `${prefix}PASSWORD`, pass);
  text = upsert(text, `${prefix}SMTP_FROM`, user);
  if (fromName) text = upsert(text, `${prefix}FROM_NAME`, fromName);

  fs.writeFileSync(CONFIG_FILE, text.replace(/\n{3,}/g, '\n\n'), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);

  return {
    warning,
    provider: key,
    host: preset.host,
    port: preset.port,
    secure: preset.secure,
    user,
    account: account || null,
  };
}

module.exports = { readMasked, writeAccount, CONFIG_FILE };
