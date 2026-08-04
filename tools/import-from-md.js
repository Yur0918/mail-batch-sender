#!/usr/bin/env node
'use strict';

/**
 * 把「Excel 平台信息 + 18 个 md 模板」灌入 config/邮件配置.xlsx。
 * 多对多模型：3 类邮件模板(监管件/先行引导/行内工单) × 6 个平台(收件人)。
 *
 *  - md 用 {{变量}} 写法，统一转成工具要求的 {变量}
 *  - 修复「行内工单」主题里重复的 {对接联系人} 写法
 *  - 平台邮箱里的中文顿号 、 转成逗号
 *  - 已有的 邮件配置.xlsx 会先备份
 *
 *   node tools/import-from-md.js
 */

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WB = path.join(ROOT, 'config', '邮件配置.xlsx');
const MD_BASE =
  '/Users/yur/Documents/Codex/2026-07-23/referenced-chatgpt-conversation-this-is-untrusted/outputs/dify_发邮件示例知识库';
const EXCEL = '/Users/yur/Desktop/发邮件平台信息.xlsx';

const TYPES = ['监管件', '先行引导', '行内工单'];
const PLATS = ['国茂', '航卓', '马消', '拍拍', '奇富', '信保'];

const TYPE_HEADERS = ['类型名称', '主题格式', '发件人显示名', '关联平台', '备注', '正文MD'];
const PLATFORM_HEADERS = ['平台名称', '收件邮箱', '抄送', '密送', '附件', '启用', '对接联系人'];

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if (value.text != null) return String(value.text);
    if (value.hyperlink != null) return String(value.hyperlink);
  }
  return String(value);
}

/** 把 md 的 {{x}} 写法转成工具的 {x} */
function toSingleBrace(s) {
  return String(s).replace(/\{\{/g, '{').replace(/\}\}/g, '}');
}

function parseMd(file) {
  const t = fs.readFileSync(file, 'utf8');
  const section = (start, end) => {
    const m = t.split('\n');
    let cap = false;
    const out = [];
    for (const l of m) {
      if (l.startsWith('## ' + start)) {
        cap = true;
        continue;
      }
      if (cap && l.startsWith('## ')) break;
      if (cap && l.trim()) out.push(l);
    }
    return toSingleBrace(out.join('\n').trim());
  };
  let subject = section('邮件主题', '邮件正文');
  let body = section('邮件正文', '必填变量');
  // 修复行内工单主题里重复的 {对接联系人}
  subject = subject.replace(/\{对接联系人\}\s*\{对接联系人\}/g, '{对接联系人}');
  return { subject, body };
}

async function readExcelPlatforms() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL);
  const ws = wb.getWorksheet('Sheet1');
  const map = {};
  for (let r = 2; r <= ws.rowCount; r++) {
    const name = cellText(ws.getRow(r).getCell(1).value).trim();
    if (!name) continue;
    let email = cellText(ws.getRow(r).getCell(2).value).trim();
    email = email.replace(/^mailto:/, '').replace(/[、]/g, ',').replace(/\s+/g, '');
    // 对接联系人示例：标题里第二个冒号后、逗号前的名字
    const title = cellText(ws.getRow(r).getCell(5).value);
    let contact = '';
    if (title) {
      const parts = title.split('：');
      if (parts.length >= 3) contact = parts[2].split(/[，,]/)[0].trim();
    }
    map[name] = { email, contact };
  }
  return map;
}

async function main() {
  // 1. 解析 md：每个类型取一份（校验同类内一致）
  const typeData = {};
  for (const ty of TYPES) {
    const subjects = new Set();
    const bodies = new Set();
    for (const p of PLATS) {
      const f = path.join(MD_BASE, ty, `${ty}_${p}.md`);
      if (!fs.existsSync(f)) {
        console.error(`缺少 md 文件：${f}`);
        process.exitCode = 1;
        return;
      }
      const { subject, body } = parseMd(f);
      subjects.add(subject);
      bodies.add(body);
    }
    if (subjects.size !== 1 || bodies.size !== 1) {
      console.warn(`⚠ 类型「${ty}」在不同平台间模板不一致，已取第一份（国茂）`);
    }
    const first = parseMd(path.join(MD_BASE, ty, `${ty}_国茂.md`));
    typeData[ty] = first;
  }

  // 2. 解析 Excel 平台
  const excelPlats = await readExcelPlatforms();

  // 3. 写 xlsx
  fs.mkdirSync(path.dirname(WB), { recursive: true });
  if (fs.existsSync(WB)) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
      d.getMinutes()
    )}`;
    const bak = WB.replace(/\.xlsx$/, `.备份${stamp}.xlsx`);
    fs.copyFileSync(WB, bak);
    console.log(`已备份原配置 → ${path.basename(bak)}`);
  }

  const wb = new ExcelJS.Workbook();
  const ts = wb.addWorksheet('类型');
  ts.addRow(TYPE_HEADERS);
  for (const ty of TYPES) {
    const d = typeData[ty];
    ts.addRow([ty, d.subject, '朱佳皓', '全部', '', d.body]);
  }

  const ps = wb.addWorksheet('平台');
  ps.addRow(PLATFORM_HEADERS);
  for (const p of PLATS) {
    const info = excelPlats[p] || { email: '', contact: '' };
    ps.addRow([p, info.email, '', '', '', '是', info.contact]);
  }

  await wb.xlsx.writeFile(WB);

  console.log('\n✓ 已导入：');
  console.log('  类型(3):', TYPES.join(' / '));
  console.log('  平台(6):', PLATS.join(' / '));
  for (const p of PLATS) {
    const info = excelPlats[p] || {};
    console.log(`    ${p.padEnd(3)} ${info.email || '(无邮箱!)'}  ${info.contact ? '对接:' + info.contact : '(对接联系人待填)'}`);
  }
  console.log('\n下一步：npm start 打开后台，或 node send.js preview --type 监管件 校验。');
}

main().catch((e) => {
  console.error('导入失败:', e.message);
  process.exitCode = 1;
});
