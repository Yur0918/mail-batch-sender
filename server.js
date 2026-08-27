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

// ---------- 发送批次（后台执行，前端轮询进度 / 可取消） ----------
// id -> { id, status:'sending'|'done', total, done, ok, fail, canceled, cancelRequested,
//         canceledCount, error, items:[{index,ok,canceled,subject,platform,customer,error}], ... }
const SEND_BATCHES = new Map();
const BATCH_TTL = 30 * 60 * 1000; // 完成后保留 30 分钟供前端查询，之后自动释放

// 启动时清理 24 小时前的残留上传临时文件（历史失败/取消批次可能遗留）
try {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    } catch (_) {}
  }
} catch (_) {}

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
app.get('/favicon.ico', (req, res) => res.status(204).end());
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
  limits: { fileSize: 20 * 1024 * 1024, files: 200 },
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
app.post('/api/upload', upload.array('files', 200), (req, res) => {
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

// ---------- 草稿（上传邮件）：发送（后台批次，返回 batchId 供轮询进度/取消） ----------
app.post('/api/send-draft', async (req, res) => {
  try {
    const { jobs, interval } = req.body;
    if (!Array.isArray(jobs) || !jobs.length) return res.status(400).json({ error: '没有邮件条目' });
    for (const b of SEND_BATCHES.values()) {
      if (b.status === 'sending') {
        return res.status(400).json({ error: '已有发送批次正在进行中，请等它完成（或在上传页取消）后再发' });
      }
    }
    const wb = await loadWorkbook(WB);
    const items = jobs.map((j) =>
      compileJob(j, { wb, uploadDir: UPLOAD_DIR, attachDir: ATTACH_DIR })
    );
    const bad = items.map((i, idx) => ({ i, idx })).filter((x) => x.i.errors.length);
    if (bad.length) {
      return res.status(400).json({
        error: '存在校验错误，已拒绝发送（保护收件人不发错）',
        items: bad.map((x) => ({ index: x.idx, platform: x.i.platform, subject: x.i.subject, errors: x.i.errors })),
      });
    }
    if (!items.length) return res.status(400).json({ error: '没有可发送的邮件' });

    const smtp = accounts.getEnabledSmtp();
    if (!smtp) {
      return res.status(400).json({ error: '尚未启用任何发件账号。请到「账号配置」标签页启用一个账号（连接测试通过后再发）' });
    }

    const id = crypto.randomBytes(8).toString('hex');
    const logger = new Logger(LOG_DIR);
    const batch = {
      id,
      status: 'sending',
      total: items.length,
      done: 0,
      ok: 0,
      fail: 0,
      canceled: false,
      cancelRequested: false,
      canceledCount: 0,
      error: '',
      items: [],
      logFile: logger.file,
    };
    SEND_BATCHES.set(id, batch);
    // 后台执行，立即返回 batchId；进度通过 /api/send-progress 轮询
    runDraftBatch(batch, items, {
      smtp,
      intervalSec: Number(interval) || 3,
      logger,
      jobs,
    }).catch((e) => {
      batch.status = 'done';
      batch.error = (e && e.message) || String(e);
      ErrorLog.error('发送批次异常', { batch: id, error: batch.error });
    });
    res.json({ ok: true, batchId: id, total: items.length });
  } catch (e) {
    ErrorLog.error('发送异常(/api/send-draft)', e);
    res.status(500).json({ error: e.message, tips: explainSmtpError(e.message, '') });
  }
});

/** 后台跑一个发送批次：逐封更新进度；只清理「已成功发送」条目的上传临时文件（失败/取消的保留以便重发） */
async function runDraftBatch(batch, items, opts) {
  const { smtp, intervalSec, logger, jobs } = opts;
  const startedAt = Date.now();
  let results = [];
  try {
    results = await sendItems(items, {
      smtp,
      interval: intervalSec * 1000,
      shouldStop: () => batch.cancelRequested,
      onEach: ({ index, item, ok, info, error }) => {
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
        batch.done += 1;
        if (ok) batch.ok += 1;
        else batch.fail += 1;
        batch.items.push({
          index,
          ok,
          canceled: false,
          subject: item.subject,
          platform: item.platform,
          customer: item.customer || '',
          error: ok ? '' : error && error.message ? error.message : String(error || ''),
        });
      },
    });
  } catch (e) {
    batch.error = (e && e.message) || String(e);
  }
  batch.canceledCount = results.filter((r) => r.canceled).length;
  batch.canceled = batch.canceledCount > 0;
  results.forEach((r) => {
    if (r.canceled) {
      batch.items.push({ index: r.index, ok: false, canceled: true, subject: r.subject || '', error: '已取消' });
    }
  });
  batch.status = 'done';
  batch.durationMs = Date.now() - startedAt;

  // 只清理成功发送条目的上传临时文件；失败/取消的保留（前端「仅重发失败项」还要用）
  const used = new Set();
  results.forEach((r, idx) => {
    if (!r.ok) return;
    const j = jobs[idx];
    if (!j) return;
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
  setTimeout(() => SEND_BATCHES.delete(batch.id), BATCH_TTL).unref();
}

function batchView(b) {
  return {
    id: b.id,
    status: b.status,
    total: b.total,
    done: b.done,
    ok: b.ok,
    fail: b.fail,
    canceled: b.canceled,
    cancelRequested: b.cancelRequested,
    canceledCount: b.canceledCount,
    error: b.error,
    items: b.items,
    logFile: b.logFile,
    durationMs: b.durationMs || null,
  };
}

// ---------- 发送进度查询 / 取消 ----------
app.get('/api/send-progress', (req, res) => {
  const id = String(req.query.id || '');
  if (!id) {
    // 不带 id：返回当前进行中的批次（页面刷新后恢复进度显示用；无则 batch=null）
    let cur = null;
    for (const b of SEND_BATCHES.values()) {
      if (b.status === 'sending') { cur = batchView(b); break; }
    }
    return res.json({ batch: cur });
  }
  const b = SEND_BATCHES.get(id);
  if (!b) return res.status(404).json({ error: '批次不存在或已过期（完成 30 分钟后自动清除）' });
  res.json(batchView(b));
});

app.post('/api/send-cancel', (req, res) => {
  const b = SEND_BATCHES.get((req.body && req.body.id) || String(req.query.id || ''));
  if (!b) return res.status(404).json({ error: '批次不存在或已过期' });
  if (b.status !== 'sending') return res.status(400).json({ error: '批次已结束，无需取消' });
  b.cancelRequested = true;
  res.json({ ok: true });
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
  if (req.query.download) {
    res.setHeader('Content-Disposition', 'attachment; filename="send-log.csv"; filename*=UTF-8\'\'' + encodeURIComponent('发送记录.csv'));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return fs.createReadStream(latest).pipe(res);
  }
  const text = fs.readFileSync(latest, 'utf8').replace(/^\uFEFF/, '');
  const entries = text
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(parseCsvLine);
  res.json({ entries, file: latest });
});

// 统一错误处理：multer 超限等中间件错误转成友好 JSON，便于前端提示。
app.use(function (err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '单个文件超过 20MB 限制' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(413).json({ error: '单次上传文件数量超过限制（最大 200 个）' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(413).json({ error: '上传字段名不正确，请使用 files 字段' });
    }
    return res.status(400).json({ error: '上传失败：' + err.message });
  }
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message || '请求错误' });
  }
  ErrorLog.error('请求处理异常', { method: req.method, path: req.path, error: err.message || err });
  res.status(500).json({ error: '服务器内部错误' });
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
