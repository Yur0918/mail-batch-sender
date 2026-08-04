'use strict';

/**
 * 多发件账号的读写（取代旧的单账号 .env 机制）。
 * 账号以数组形式存于 data/accounts.json（便携包在 MAILER_DATA_DIR 下），
 * 密码明文保存，文件权限 600。首次启动时若检测到旧的 .env 凭据，自动迁移为第一个启用账号。
 *
 * 约束：同一时刻仅允许一个账号 enabled=true（保存时自动互斥）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadSmtpConfig } = require('./config');
const { createTransport, explainSmtpError } = require('./mailer');

const DATA_DIR = process.env.MAILER_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'accounts.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function readAll() {
  // 首次使用：从旧的 .env 单账号迁移
  if (!fs.existsSync(FILE)) {
    const acc = migrateFromLegacy();
    if (acc) {
      writeAll([acc]);
      return [acc];
    }
    return [];
  }
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

function writeAll(list) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}

/** 从旧 .env 迁移出第一个账号（无则返回 null）。 */
function migrateFromLegacy() {
  try {
    const legacy = loadSmtpConfig();
    if (!legacy || !legacy.host || !legacy.user || !legacy.pass) return null;
    return {
      id: 'acc_' + crypto.randomBytes(4).toString('hex'),
      name: legacy.user,
      host: legacy.host,
      port: legacy.port,
      secure: legacy.secure,
      user: legacy.user,
      pass: legacy.pass,
      fromName: legacy.fromName || '',
      from: legacy.from || legacy.user,
      rejectUnauthorized: legacy.rejectUnauthorized !== false,
      enabled: true,
      createdAt: Date.now(),
    };
  } catch (_) {
    return null;
  }
}

function mask(a) {
  const c = { ...a };
  delete c.pass;
  c.hasPass = !!a.pass;
  return c;
}

/** 列表（密码脱敏，仅暴露 hasPass 标记）。 */
function list() {
  return readAll().map(mask);
}

/** 取原始记录（含密码），仅内部/测试接口使用。 */
function getRaw(id) {
  return readAll().find((a) => a.id === id) || null;
}

/** 取当前启用的账号原始记录（含密码），无则返回 null。 */
function getEnabled() {
  return readAll().find((a) => a.enabled) || null;
}

/** 转成 sendItems 需要的 smtp 形状。无启用账号返回 null。 */
function getEnabledSmtp() {
  const a = getEnabled();
  if (!a) return null;
  return {
    host: a.host,
    port: Number(a.port),
    secure: !!a.secure,
    user: a.user,
    pass: a.pass,
    from: a.from || a.user,
    fromName: a.fromName || '',
    rejectUnauthorized: a.rejectUnauthorized !== false,
  };
}

/**
 * 新增或更新账号。
 * @param {object} acc { id?, name, host, port, secure, user, pass, fromName, from, rejectUnauthorized, enabled }
 *   - 更新（带 id）且 pass 为空 → 保留原密码
 *   - enabled=true 时，其它账号自动置为 false（唯一启用）
 */
function upsert(acc) {
  const all = readAll();
  let rec;
  if (acc.id) {
    const i = all.findIndex((a) => a.id === acc.id);
    if (i === -1) throw new Error('账号不存在：' + acc.id);
    rec = { ...all[i] };
  } else {
    rec = { id: 'acc_' + crypto.randomBytes(4).toString('hex'), createdAt: Date.now() };
  }

  if (acc.name != null) rec.name = acc.name;
  if (acc.host != null) rec.host = String(acc.host).trim();
  if (acc.port != null) rec.port = Number(acc.port) || 465;
  if (acc.secure != null) rec.secure = !!acc.secure;
  if (acc.user != null) rec.user = String(acc.user).trim();
  if (acc.pass != null && String(acc.pass).length) rec.pass = String(acc.pass);
  if (acc.fromName != null) rec.fromName = acc.fromName;
  if (acc.from != null && String(acc.from).trim()) rec.from = String(acc.from).trim();
  else if (acc.user != null) rec.from = rec.user; // 未单独填发件地址时用登录账号
  if (acc.rejectUnauthorized != null) rec.rejectUnauthorized = !!acc.rejectUnauthorized;
  rec.enabled = acc.enabled != null ? !!acc.enabled : rec.enabled || false;

  if (rec.enabled) all.forEach((a) => { if (a.id !== rec.id) a.enabled = false; });

  if (acc.id) all[all.findIndex((a) => a.id === acc.id)] = rec;
  else all.push(rec);

  writeAll(all);
  return mask(rec);
}

function remove(id) {
  const all = readAll().filter((a) => a.id !== id);
  writeAll(all);
}

/**
 * 连接测试：只做握手 + 认证，不发送邮件。
 * @param {object} acc { host, port, secure, user, pass, rejectUnauthorized }
 */
async function test(acc) {
  const smtp = {
    host: acc.host,
    port: Number(acc.port) || 465,
    secure: !!acc.secure,
    user: acc.user,
    pass: acc.pass,
    rejectUnauthorized: acc.rejectUnauthorized !== false,
  };
  if (!smtp.host || !smtp.user || !smtp.pass) {
    throw new Error('缺少 host / 账号 / 密码，无法测试连接');
  }
  const transporter = createTransport(smtp);
  try {
    await transporter.verify();
  } finally {
    try { transporter.close(); } catch (_) {}
  }
  return true;
}

async function testById(id) {
  const a = getRaw(id);
  if (!a) throw new Error('账号不存在：' + id);
  return test({
    host: a.host, port: a.port, secure: a.secure,
    user: a.user, pass: a.pass, rejectUnauthorized: a.rejectUnauthorized,
  });
}

/** 将连接测试结果回写到账号记录（含时间、是否成功、失败错误信息）。 */
function markTestResult(id, ok, error) {
  const all = readAll();
  const i = all.findIndex((a) => a.id === id);
  if (i === -1) return null;
  all[i].lastTestAt = Date.now();
  all[i].lastTestOk = !!ok;
  all[i].lastTestError = ok ? '' : (error || '');
  writeAll(all);
  return mask(all[i]);
}

module.exports = {
  list, getRaw, getEnabled, getEnabledSmtp, upsert, remove, test, testById, markTestResult, FILE,
};
