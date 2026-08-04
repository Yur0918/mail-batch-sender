'use strict';

/**
 * CSV 发送日志。每封邮件发完立即落盘，中途崩溃也不丢已发记录。
 * 文件：logs/发送记录_YYYY-MM-DD.csv（UTF-8 BOM，Excel 直接打开不乱码）
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const COLUMNS = [
  '时间',
  '邮件类型',
  '平台',
  '客户姓名',
  '收件邮箱',
  '抄送',
  '主题',
  '附件',
  '状态',
  '详情',
  '配置行号',
];

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 旧表头文件备份名：发送记录_YYYY-MM-DD_old_时间戳.csv，若重名追加序号 */
function oldBackupPath(file) {
  const base = file.replace(/\.csv$/, '');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const suffix = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let cand = `${base}_old_${suffix}.csv`;
  for (let i = 1; fs.existsSync(cand); i++) cand = `${base}_old_${suffix}_${i}.csv`;
  return cand;
}

class Logger {
  constructor(logDir, date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    this.dir = logDir;
    this.file = path.join(logDir, `发送记录_${stamp}.csv`);
    fs.mkdirSync(logDir, { recursive: true });

    const headerLine = '\uFEFF' + COLUMNS.join(',') + '\n';
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, headerLine, 'utf8');
      return;
    }
    // 旧 CSV 兼容：已存在文件的首行表头与当前 COLUMNS 不一致时，
    // 把旧文件改名备份（_old_时间戳），再写新表头文件，避免新行按新顺序落到旧表头下导致列错位。
    const firstLine = fs
      .readFileSync(this.file, 'utf8')
      .split(/\r?\n/, 1)[0]
      .replace(/^\uFEFF/, '');
    if (firstLine !== COLUMNS.join(',')) {
      fs.renameSync(this.file, oldBackupPath(this.file));
      fs.writeFileSync(this.file, headerLine, 'utf8');
    }
  }

  append(record) {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts =
      `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
      `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const line = [
      ts,
      record.type,
      record.platform,
      record.customer,
      record.to,
      record.cc,
      record.subject,
      (record.attachments || []).join(';'),
      record.status,
      record.detail,
      record.row,
    ]
      .map(csvEscape)
      .join(',');
    fs.appendFileSync(this.file, line + '\n', 'utf8');
  }
}

/** 读取最近一次日志里状态为「失败」的记录键（渠道+收件邮箱） */
function readFailedKeys(logDir) {
  if (!fs.existsSync(logDir)) return new Set();
  const files = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith('发送记录_') && f.endsWith('.csv') && !f.includes('_old'))
    .sort();
  if (!files.length) return new Set();

  const latest = path.join(logDir, files[files.length - 1]);
  const text = fs.readFileSync(latest, 'utf8').replace(/^\uFEFF/, '');
  const succeeded = new Set();
  const failed = new Set();

  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    // 新列：0时间/1邮件类型/2平台/3客户姓名/4收件邮箱/5抄送/6主题/7附件/8状态/9详情/10配置行号
    const channel = cells[1] || '';
    const to = cells[4] || '';
    const status = cells[8] || '';
    const key = `${channel}\u0000${to}`;
    if (status === '成功') succeeded.add(key);
    else if (status === '失败') failed.add(key);
  }
  // 后来发成功的不再算失败
  for (const k of succeeded) failed.delete(k);
  return failed;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// ---------- 运行期报错日志（落盘，便于一步定位根因） ----------
// 与发送 CSV 不同：这里记录崩溃、未捕获异常、连接测试失败、启动信息等，
// 任何让工具"打不开/发不出"的报错都会被写到 logs/mailer-error.log。
const ERR_LOG = path.join(__dirname, '..', 'logs', 'mailer-error.log');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function fmt(a) {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a);
    } catch (_) {
      return String(a);
    }
  }
  return String(a);
}

function writeErr(level, args) {
  try {
    // 用 GBK 落盘：与启动.bat（chcp 936）写入同一文件编码一致，Win7 记事本原生不乱码
    const line = `[${stamp()}] [${level}] ${args.map(fmt).join(' ')}\n`;
    fs.appendFileSync(ERR_LOG, iconv.encode(line, 'gbk'));
  } catch (_) {}
}

const ErrorLog = {
  info: (...a) => writeErr('INFO', a),
  warn: (...a) => writeErr('WARN', a),
  error: (...a) => writeErr('ERROR', a),
  file: ERR_LOG,
};

/**
 * 安装全局报错捕获：
 * 1) 把 console.log/info/warn/error 同时镜像到报错日志文件（保留全部运行输出）
 * 2) 捕获 uncaughtException（写日志后退出，避免半死不活）与 unhandledRejection
 * 这样无论工具是"运行时报错"还是"直接崩溃"，根因都留在 logs/mailer-error.log。
 */
function installGlobalHandlers() {
  try {
    fs.mkdirSync(path.dirname(ERR_LOG), { recursive: true });
  } catch (_) {}
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...a) => {
    orig.log(...a);
    ErrorLog.info(...a);
  };
  console.info = (...a) => {
    orig.info(...a);
    ErrorLog.info(...a);
  };
  console.warn = (...a) => {
    orig.warn(...a);
    ErrorLog.warn(...a);
  };
  console.error = (...a) => {
    orig.error(...a);
    ErrorLog.error(...a);
  };

  process.on('uncaughtException', (e) => {
    ErrorLog.error('UNCAUGHT_EXCEPTION', e);
    orig.error('[FATAL] uncaughtException:', e);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    ErrorLog.error('UNHANDLED_REJECTION', e);
    orig.error('[WARN] unhandledRejection:', e);
  });
}

module.exports = { Logger, readFailedKeys, parseCsvLine, ErrorLog, installGlobalHandlers };
