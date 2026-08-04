'use strict';

/**
 * 配置工作簿（config/邮件配置.xlsx）的读写层。
 * 多对多模型：类型(模板) × 平台(收件人)。既给 web server 做 CRUD，也保持与 CLI 共用同一份文件。
 *
 * Sheet「类型」: 类型名称 | 主题格式 | 发件人显示名 | 关联平台 | 备注 | 正文MD
 * Sheet「平台」: 平台名称 | 收件邮箱 | 抄送 | 密送 | 附件 | 启用 | 对接联系人 | (任意扩展列→变量)
 */

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { loadWorkbook, cellText } = require('./workbook');

const SHEET_TYPE = '类型';
const SHEET_PLATFORM = '平台';
const TYPE_HEADERS = ['类型名称', '主题格式', '发件人显示名', '关联平台', '备注', '正文MD'];
const PLATFORM_HEADERS = ['平台名称', '收件邮箱', '抄送', '密送', '附件', '启用'];

// 前端英文字段名 → xlsx 中文表头（平台写入专用；类型写入直接用字面量中文表头）
const PLATFORM_FIELD_MAP = {
  name: '平台名称',
  to: '收件邮箱',
  cc: '抄送',
  bcc: '密送',
  attachments: '附件',
  enabled: '启用',
};

function toHeader(k) {
  return PLATFORM_FIELD_MAP[k] || k;
}

function headerOf(ws) {
  const row = ws.getRow(1);
  const header = [];
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    header[col - 1] = cellText(cell.value).trim();
  });
  return header;
}

function setCellByHeader(ws, rowNumber, header, key, value) {
  let col = header.indexOf(key);
  if (col === -1) {
    col = header.length;
    ws.getRow(1).getCell(col + 1).value = key;
    header[col] = key;
  }
  ws.getRow(rowNumber).getCell(col + 1).value = value == null ? '' : String(value);
}

function findRowByCol(ws, header, colKey, value) {
  for (let r = 2; r <= ws.rowCount; r++) {
    const v = cellText(ws.getRow(r).getCell(header.indexOf(colKey) + 1).value).trim();
    if (v === String(value).trim()) return r;
  }
  return -1;
}

function firstEmptyRow(ws) {
  for (let r = 2; r <= ws.rowCount + 1; r++) {
    const row = ws.getRow(r);
    let empty = true;
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (cellText(cell.value).trim()) empty = false;
    });
    if (empty) return r;
  }
  return ws.rowCount + 1;
}

async function open(filePath) {
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(filePath)) await wb.xlsx.readFile(filePath);
  return wb;
}
function ensureSheet(wb, name) {
  let ws = wb.getWorksheet(name);
  if (!ws) ws = wb.addWorksheet(name);
  return ws;
}

/** 读取整份配置，归一化为 types / platforms / platformColumns */
async function readAll(filePath) {
  const wb = await loadWorkbook(filePath);
  const types = [...wb.types.values()].map((t) => ({
    name: t.name,
    subjectTemplate: t.subjectTemplate,
    body: t.bodyTemplate,
    senderName: t.senderName,
    relatedPlatforms: t.relatedPlatforms,
    note: t.note,
    platformCount:
      t.relatedPlatforms === '全部'
        ? wb.platforms.filter((p) => p.enabled).length
        : wb.platforms.filter((p) => p.enabled && t.relatedPlatforms.includes(p.name)).length,
  }));
  const platforms = wb.platforms.map((p) => ({
    row: p.row,
    name: p.name,
    to: p.to,
    cc: p.cc,
    bcc: p.bcc,
    attachments: p.attachments.join(';'),
    enabled: p.enabled,
    contact: p.vars['客户姓名'] || p.vars['对接联系人'] || '',
    vars: p.vars,
  }));
  const platformColumns = wb.platformColumns;
  return { types, platforms, platformColumns };
}

// ---------------- 类型 ----------------

async function createType(filePath, { name, subjectTemplate, body, senderName, relatedPlatforms, note }) {
  const wb = await open(filePath);
  const ws = ensureSheet(wb, SHEET_TYPE);
  if (!headerOf(ws).length) TYPE_HEADERS.forEach((h, i) => (ws.getRow(1).getCell(i + 1).value = h));
  const header = headerOf(ws);
  if (findRowByCol(ws, header, '类型名称', name) !== -1) throw new Error(`类型「${name}」已存在`);
  const row = firstEmptyRow(ws);
  setCellByHeader(ws, row, header, '类型名称', name);
  setCellByHeader(ws, row, header, '主题格式', subjectTemplate || '');
  setCellByHeader(ws, row, header, '发件人显示名', senderName || '');
  setCellByHeader(
    ws,
    row,
    header,
    '关联平台',
    Array.isArray(relatedPlatforms) ? relatedPlatforms.join(',') : relatedPlatforms || '全部'
  );
  setCellByHeader(ws, row, header, '备注', note || '');
  setCellByHeader(ws, row, header, '正文MD', body || '');
  await wb.xlsx.writeFile(filePath);
  return { name, subjectTemplate, body };
}

async function saveType(filePath, name, { subjectTemplate, body, senderName, relatedPlatforms, note }) {
  const wb = await open(filePath);
  const ws = getSheet(wb, SHEET_TYPE);
  if (!ws) throw new Error(`缺少 sheet「${SHEET_TYPE}」`);
  const header = headerOf(ws);
  const row = findRowByCol(ws, header, '类型名称', name);
  if (row === -1) throw new Error(`类型「${name}」不存在`);
  setCellByHeader(ws, row, header, '主题格式', subjectTemplate || '');
  setCellByHeader(ws, row, header, '发件人显示名', senderName || '');
  setCellByHeader(
    ws,
    row,
    header,
    '关联平台',
    Array.isArray(relatedPlatforms) ? relatedPlatforms.join(',') : relatedPlatforms || '全部'
  );
  setCellByHeader(ws, row, header, '备注', note || '');
  setCellByHeader(ws, row, header, '正文MD', body || '');
  await wb.xlsx.writeFile(filePath);
  return { name, subjectTemplate, body };
}

async function deleteType(filePath, name) {
  const wb = await open(filePath);
  const ws = getSheet(wb, SHEET_TYPE);
  if (!ws) throw new Error(`缺少 sheet「${SHEET_TYPE}」`);
  const header = headerOf(ws);
  const row = findRowByCol(ws, header, '类型名称', name);
  if (row === -1) throw new Error(`类型「${name}」不存在`);
  ws.spliceRows(row, 1);
  await wb.xlsx.writeFile(filePath);
  return { ok: true };
}

// ---------------- 平台 ----------------

async function createPlatform(filePath, fields) {
  const wb = await open(filePath);
  const ws = ensureSheet(wb, SHEET_PLATFORM);
  if (!headerOf(ws).length) PLATFORM_HEADERS.forEach((h, i) => (ws.getRow(1).getCell(i + 1).value = h));
  const header = headerOf(ws);
  const row = firstEmptyRow(ws);
  for (const [k, v] of Object.entries(fields)) {
    setCellByHeader(ws, row, header, toHeader(k), v);
  }
  await wb.xlsx.writeFile(filePath);
  return { row };
}

async function savePlatform(filePath, row, fields) {
  const wb = await open(filePath);
  const ws = getSheet(wb, SHEET_PLATFORM);
  if (!ws) throw new Error(`缺少 sheet「${SHEET_PLATFORM}」`);
  const header = headerOf(ws);
  if (row < 2 || row > ws.rowCount) throw new Error(`行号 ${row} 无效`);
  for (const [k, v] of Object.entries(fields)) {
    setCellByHeader(ws, row, header, toHeader(k), v);
  }
  await wb.xlsx.writeFile(filePath);
  return { ok: true };
}

async function deletePlatform(filePath, row) {
  const wb = await open(filePath);
  const ws = getSheet(wb, SHEET_PLATFORM);
  if (!ws) throw new Error(`缺少 sheet「${SHEET_PLATFORM}」`);
  if (row < 2 || row > ws.rowCount) throw new Error(`行号 ${row} 无效`);
  ws.spliceRows(row, 1);
  await wb.xlsx.writeFile(filePath);
  return { ok: true };
}

function getSheet(wb, name) {
  return wb.getWorksheet(name);
}

module.exports = {
  readAll,
  createType,
  saveType,
  deleteType,
  createPlatform,
  savePlatform,
  deletePlatform,
};
