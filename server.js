#!/usr/bin/env node
'use strict';

/**
 * 邮件后台 Web 服务（自托管小工具，经办在浏览器里用）
 *
 *   node server.js           启动，默认 http://localhost:3000
 *   PORT=8080 node server.js 指定端口
 *
 * 多对多模型：类型(模板) × 平台(收件人)。与 CLI 共用 config/邮件配置.xlsx 与 ~/.config/mail-skills/.env。
 */

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');

const { loadSmtpConfig } = require('./lib/config');
const { loadWorkbook } = require('./lib/workbook');
const { buildPlan } = require('./lib/plan');
const { compileJob } = require('./lib/draft');
const { sendItems, explainSmtpError } = require('./lib/mailer');
const accounts = require('./lib/accounts');
const {
  readAll,
  createType,
  saveType,
  deleteType,
  createPlatform,
  savePlatform,
  deletePlatform,
} = require('./lib/store');
const { writeAccount, readMasked } = require('./lib/account');
const { render } = require('./lib/md');
const { Logger, parseCsvLine, ErrorLog, installGlobalHandlers } = require('./lib/logger');

const ROOT = __dirname;
const WB = path.join(ROOT, 'config', '邮件配置.xlsx');
const ATTACH_DIR = path.join(ROOT, 'attachments');
const UPLOAD_DIR = path.join(ATTACH_DIR, '.uploads');
const LOG_DIR = path.join(ROOT, 'logs');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// 安装全局报错捕获：把控制台输出镜像到 logs/mailer-error.log，并捕获崩溃/未处理 rejection。
// 这样以后再报错，根因一步可查（界面「发送日志」tab 里也能看/下载）。
installGlobalHandlers();
ErrorLog.info('邮件后台启动', {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cwd: __dirname,
  dataDir: process.env.MAILER_DATA_DIR || '(未设置，用默认)',
});

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const uploadStorage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(12).toString('hex');
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
      .slice(0, 60);
    cb(null, `${id}-${base}${ext}`);
  },
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

async function buildPreviewItems(typeName, platformRows, extraUploads, overrides) {
  const wb = await loadWorkbook(WB);
  const plan = buildPlan(wb, { type: typeName, platformRows, attachDir: ATTACH_DIR, overrides });
  let items = plan.items;
  if (extraUploads && extraUploads.length) {
    const extra = extraUploads
      .map((name) => {
        const p = path.join(UPLOAD_DIR, name);
        return fs.existsSync(p) ? { name: path.basename(p), path: p, raw: name } : null;
      })
      .filter(Boolean);
    items = items.map((i) => ({ ...i, attachments: [...(i.attachments || []), ...extra] }));
  }
  return items;
}

// ---------- 配置状态 ----------
app.get('/api/state', async (req, res) => {
  try {
    const data = await readAll(WB);
    const smtp = readMasked();
    const enabled = accounts.getEnabled();
    res.json({
      ...data,
      smtp: smtp ? { ...smtp, configured: true } : { configured: false },
      account: enabled ? { name: enabled.name, user: enabled.user } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 类型（邮件主题/正文模板） ----------
app.get('/api/types', async (req, res) => {
  try {
    const { types } = await readAll(WB);
    res.json(types);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/types', async (req, res) => {
  try {
    const r = await createType(WB, req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/types/:name', async (req, res) => {
  try {
    const r = await saveType(WB, decodeURIComponent(req.params.name), req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/types/:name', async (req, res) => {
  try {
    const r = await deleteType(WB, decodeURIComponent(req.params.name));
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 平台（接收方） ----------
app.get('/api/platforms', async (req, res) => {
  try {
    const { platforms, platformColumns } = await readAll(WB);
    res.json({ platforms, platformColumns });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/platforms', async (req, res) => {
  try {
    const r = await createPlatform(WB, req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/platforms/:row', async (req, res) => {
  try {
    const r = await savePlatform(WB, Number(req.params.row), req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/platforms/:row', async (req, res) => {
  try {
    const r = await deletePlatform(WB, Number(req.params.row));
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- SMTP 账号 ----------
app.get('/api/smtp', (req, res) => {
  const m = readMasked();
  res.json(m ? { ...m, configured: true } : { configured: false });
});

app.post('/api/smtp', (req, res) => {
  try {
    const r = writeAccount(req.body);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message, code: e.code });
  }
});

// ---------- 多发件账号（JSON 存储，仅一个启用） ----------
app.get('/api/accounts', (req, res) => {
  res.json({ accounts: accounts.list(), file: accounts.FILE });
});

app.post('/api/accounts', (req, res) => {
  try {
    const b = req.body || {};
    // 新增（无 id）必须填 host/user；按 id 更新（如仅切换启用）允许只传部分字段
    if (!b.id && (!b.host || !b.user)) {
      return res.status(400).json({ error: '请填 SMTP Host 与邮箱账号' });
    }
    // 编辑且密码留空 → 保留原密码
    if (b.id && !String(b.pass || '').length) {
      const cur = accounts.getRaw(b.id);
      if (cur) b.pass = cur.pass;
    }
    const rec = accounts.upsert(b);
    res.json({ ok: true, account: rec });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts', (req, res) => {
  const id = req.query.id || (req.body && req.body.id);
  if (!id) return res.status(400).json({ error: '缺少 id' });
  accounts.remove(id);
  res.json({ ok: true });
});

// 连接测试（不发送邮件）：可用表单内的临时值，或传 id 用已存账号
app.post('/api/accounts/test', async (req, res) => {
  const b = req.body || {};
  let ok = false;
  let error = '';
  try {
    // 表单内测试优先用当前填写的值；列表行测试仅传 id
    if (b.host || b.user) ok = await accounts.test(b);
    else if (b.id) ok = await accounts.testById(b.id);
    else throw new Error('缺少 host/账号 或 id，无法测试');
  } catch (e) {
    ok = false;
    error = e.message || String(e);
    ErrorLog.error('连接测试失败', { host: b.host || '', user: b.user || '', id: b.id || '', error });
  }
  let account = null;
  if (b.id) account = accounts.markTestResult(b.id, ok, error);
  if (ok) {
    res.json({ ok: true, account });
  } else {
    res.status(400).json({ ok: false, account, error, tips: explainSmtpError(error, b.host || '') });
  }
});

// ---------- Markdown 实时预览 ----------
app.post('/api/render', (req, res) => {
  res.json({ html: render(req.body.md || '', { email: true }) });
});

// ---------- 附件上传（发送时追加） ----------
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map((f) => ({
    id: path.basename(f.path),
    name: f.originalname,
    size: f.size,
  }));
  res.json({ files });
});

// ---------- 预览（不发信） ----------
app.post('/api/preview', async (req, res) => {
  try {
    const { type, platformRows, uploaded, overrides } = req.body;
    if (!type) return res.status(400).json({ error: '缺少 type' });
    const items = await buildPreviewItems(type, platformRows, uploaded, overrides);
    res.json({ items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 发送 ----------
app.post('/api/send', async (req, res) => {
  try {
    const { type, platformRows, interval, uploaded, overrides } = req.body;
    if (!type) return res.status(400).json({ error: '缺少 type' });
    const items = await buildPreviewItems(type, platformRows, uploaded, overrides);
    const bad = items.filter((i) => i.errors.length);
    if (bad.length) {
      return res.status(400).json({
        error: '存在校验错误，已拒绝发送（保护收件人不发错）',
        items: bad.map((i) => ({ row: i.row, subject: i.subject, errors: i.errors })),
      });
    }
    if (!items.length) return res.status(400).json({ error: '没有可发送的邮件' });

    const smtp = accounts.getEnabledSmtp();
    if (!smtp) {
      return res.status(400).json({ error: '尚未启用任何发件账号。请到「账号配置」标签页启用一个账号（连接测试通过后再发）' });
    }
    const logger = new Logger(LOG_DIR);
    const results = await sendItems(items, {
      smtp,
      interval: (Number(interval) || 3) * 1000,
      onEach: ({ item, ok, info, error }) => {
        logger.append({
          type: item.type,
          platform: item.platform,
          customer: item.customer || '',
          to: Array.isArray(item.to) ? item.to.join(';') : item.to,
          cc: item.cc.join(';'),
          subject: item.subject,
          attachments: item.attachments.map((a) => a.name),
          status: ok ? '成功' : '失败',
          detail: ok ? info.messageId : error,
          row: item.row,
        });
      },
    });

    if (uploaded && uploaded.length) {
      uploaded.forEach((n) => {
        const p = path.join(UPLOAD_DIR, n);
        try {
          fs.unlinkSync(p);
        } catch (_) {}
      });
    }
    res.json({ results, logFile: logger.file });
  } catch (e) {
    ErrorLog.error('发送异常(/api/send)', e);
    res.status(500).json({ error: e.message, tips: explainSmtpError(e.message, '') });
  }
});

// ---------- 草稿（上传邮件）：预览校验 ----------
app.post('/api/preview-draft', async (req, res) => {
  try {
    const { jobs } = req.body;
    if (!Array.isArray(jobs) || !jobs.length) return res.status(400).json({ error: '没有邮件条目' });
    const wb = await loadWorkbook(WB);
    const items = jobs.map((j) =>
      compileJob(j, { wb, uploadDir: UPLOAD_DIR, attachDir: ATTACH_DIR })
    );
    res.json({ items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 草稿（上传邮件）：发送 ----------
app.post('/api/send-draft', async (req, res) => {
  try {
    const { jobs, interval } = req.body;
    if (!Array.isArray(jobs) || !jobs.length) return res.status(400).json({ error: '没有邮件条目' });
    const wb = await loadWorkbook(WB);
    const items = jobs.map((j) =>
      compileJob(j, { wb, uploadDir: UPLOAD_DIR, attachDir: ATTACH_DIR })
    );
    const bad = items.filter((i) => i.errors.length);
    if (bad.length) {
      return res.status(400).json({
        error: '存在校验错误，已拒绝发送（保护收件人不发错）',
        items: bad.map((i) => ({ platform: i.platform, subject: i.subject, errors: i.errors })),
      });
    }
    if (!items.length) return res.status(400).json({ error: '没有可发送的邮件' });

    const smtp = accounts.getEnabledSmtp();
    if (!smtp) {
      return res.status(400).json({ error: '尚未启用任何发件账号。请到「账号配置」标签页启用一个账号（连接测试通过后再发）' });
    }
    const logger = new Logger(LOG_DIR);
    const results = await sendItems(items, {
      smtp,
      interval: (Number(interval) || 3) * 1000,
      onEach: ({ item, ok, info, error }) => {
        logger.append({
          type: item.type,
          platform: item.platform,
          customer: item.customer || '',
          to: Array.isArray(item.to) ? item.to.join(';') : item.to,
          cc: item.cc.join(';'),
          subject: item.subject,
          attachments: item.attachments.map((a) => a.name),
          status: ok ? '成功' : '失败',
          detail: ok ? info.messageId : error,
          row: item.row,
        });
      },
    });

    // 发送成功后清理本次上传的临时文件
    const used = new Set();
    jobs.forEach((j) => {
      if (j.bodyFileId) used.add(path.basename(j.bodyFileId));
      // f 可能是字符串（旧接口）或 {id,name} 对象（前端 jobsFromEntries 当前形态），兼容两种
      (j.attachments || []).forEach((f) => used.add(path.basename(typeof f === 'string' ? f : f.id)));
    });
    used.forEach((n) => {
      const p = path.join(UPLOAD_DIR, n);
      try {
        fs.unlinkSync(p);
      } catch (_) {}
    });
    res.json({ results, logFile: logger.file });
  } catch (e) {
    ErrorLog.error('发送异常(/api/send-draft)', e);
    res.status(500).json({ error: e.message, tips: explainSmtpError(e.message, '') });
  }
});

// ---------- 运行报错日志（供界面查看/下载，一步定位根因） ----------
// 日志文件以 GBK 落盘（与启动.bat chcp 936 一致，Win7 记事本原生不乱码）。
// 读取时解码为 UTF-8 返回给前端；下载则发回原始 GBK 字节，记事本直接打开正确。
app.get('/api/error-log', (req, res) => {
  const f = path.join(LOG_DIR, 'mailer-error.log');
  if (!fs.existsSync(f)) return res.json({ text: '', file: null });
  const buf = fs.readFileSync(f);
  let text = iconv.decode(buf, 'gbk');
  const MAX = 200 * 1024;
  if (Buffer.byteLength(text, 'utf8') > MAX) {
    text = '…（日志较长，仅显示末尾 200KB）…\n' + text.slice(-MAX / 2);
  }
  if (req.query.download) {
    res.setHeader('Content-Disposition', 'attachment; filename="mailer-error.log"');
    res.setHeader('Content-Type', 'text/plain; charset=gbk');
    return res.send(buf);
  }
  res.json({ text, file: f });
});

// ---------- 发送日志 ----------
app.get('/api/logs', (req, res) => {
  if (!fs.existsSync(LOG_DIR)) return res.json({ entries: [], file: null });
  const files = fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.startsWith('发送记录_') && f.endsWith('.csv') && !f.includes('_old'))
    .sort();
  if (!files.length) return res.json({ entries: [], file: null });
  const latest = path.join(LOG_DIR, files[files.length - 1]);
  const text = fs.readFileSync(latest, 'utf8').replace(/^\uFEFF/, '');
  const entries = text
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(parseCsvLine);
  res.json({ entries, file: latest });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n邮件后台已启动：http://localhost:${PORT}`);
  console.log(`配置文件：${WB}`);
  console.log(`账号配置：${require('./lib/account').CONFIG_FILE}\n`);
  // 重置报错日志为本次运行（GBK 覆盖写），避免旧版 UTF-8 残留与本轮 GBK 混合导致乱码
  try {
    fs.writeFileSync(ErrorLog.file, iconv.encode('', 'gbk'));
  } catch (_) {}
  ErrorLog.info('启动', {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    port: PORT,
    dataDir: process.env.MAILER_DATA_DIR || '(默认)',
    url: `http://localhost:${PORT}`,
  });
  ErrorLog.info('已监听端口', { port: PORT, url: `http://localhost:${PORT}` });
});

module.exports = app;
