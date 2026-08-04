'use strict';

/**
 * 解析 Excel 配置工作簿（多对多模型）。
 *
 * Sheet 「类型」: 类型名称 | 主题格式 | 发件人显示名 | 关联平台 | 备注 | 正文MD
 *   - 一套邮件模板（主题格式 + Markdown 正文），可被多个平台共用
 *   - 关联平台: "全部" 或逗号分隔的平台名称列表（决定该类型发给哪些平台）
 * Sheet 「平台」: 平台名称 | 收件邮箱 | 抄送 | 密送 | 附件 | 启用 | (任意扩展列→变量)
 *   - 一个收件方实体，含邮箱；客户姓名在「上传发送」里由文件名解析，不在此列存储
 */

const ExcelJS = require('exceljs');

const SHEET_TYPE = '类型';
const SHEET_PLATFORM = '平台';
const STANDARD_PLATFORM_COLS = ['平台名称', '收件邮箱', '抄送', '密送', '附件', '启用'];

/** exceljs 单元格值 -> 纯字符串 */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.hyperlink !== undefined) return String(value.hyperlink);
    if (value.result !== undefined) return cellText(value.result);
    if (value.formula !== undefined) return '';
  }
  return String(value);
}

/** 读取表头行，返回 [列名] 数组（索引从 0 起，对应第 1 列） */
function readHeader(sheet) {
  const header = [];
  const row = sheet.getRow(1);
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    header[colNumber - 1] = cellText(cell.value).trim();
  });
  return header;
}

/** 把 sheet 解析为对象数组，跳过全空行和以 # 开头的说明行 */
function sheetToObjects(sheet) {
  const header = readHeader(sheet);
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj = {};
    let hasValue = false;
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      const text = cellText(row.getCell(c + 1).value).trim();
      obj[key] = text;
      if (text) hasValue = true;
    }
    if (!hasValue) continue;
    const first = cellText(row.getCell(1).value).trim();
    if (first.startsWith('#')) continue; // 说明行
    obj.__row = r;
    rows.push(obj);
  }
  return { header: header.filter(Boolean), rows };
}

function parseRelated(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '全部') return '全部';
  return s
    .split(/[,，;；]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function loadWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const typeSheet = wb.getWorksheet(SHEET_TYPE);
  if (!typeSheet) throw new Error(`配置文件缺少 sheet「${SHEET_TYPE}」：${filePath}`);
  const platformSheet = wb.getWorksheet(SHEET_PLATFORM);
  if (!platformSheet) throw new Error(`配置文件缺少 sheet「${SHEET_PLATFORM}」：${filePath}`);

  const { rows: typeRows } = sheetToObjects(typeSheet);
  const { header: platformHeader, rows: platformRows } = sheetToObjects(platformSheet);

  const types = new Map();
  for (const row of typeRows) {
    const name = (row['类型名称'] || '').trim();
    if (!name) continue;
    types.set(name, {
      name,
      subjectTemplate: (row['主题格式'] || '').trim(),
      bodyTemplate: row['正文MD'] != null ? String(row['正文MD']) : '',
      senderName: (row['发件人显示名'] || '').trim(),
      note: (row['备注'] || '').trim(),
      relatedPlatforms: parseRelated(row['关联平台']),
      row: row.__row,
    });
  }

  const platforms = platformRows.map((row) => {
    const enabled = !row['启用'] || !/否|0|n|false|off|禁用/i.test(row['启用']);
    const vars = {};
    for (const key of platformHeader) vars[key] = row[key] || '';
    return {
      name: (row['平台名称'] || '').trim(),
      to: (row['收件邮箱'] || '').trim(),
      cc: (row['抄送'] || '').trim(),
      bcc: (row['密送'] || '').trim(),
      attachments: (row['附件'] || '')
        .split(/[;；]/)
        .map((s) => s.trim())
        .filter(Boolean),
      enabled,
      vars, // 含 对接联系人 及任意扩展变量列
      row: row.__row,
    };
  });

  const platformColumns = platformHeader.filter((c) => !STANDARD_PLATFORM_COLS.includes(c));

  return { types, platforms, platformColumns, filePath };
}

module.exports = { loadWorkbook, SHEET_TYPE, SHEET_PLATFORM, cellText };
