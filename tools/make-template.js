#!/usr/bin/env node
'use strict';

/**
 * 生成 / 重置 config/邮件配置.xlsx 模板（多对多模型）。
 * 已存在则备份为 邮件配置.备份YYYYMMDD-HHMM.xlsx 再覆盖。
 *
 *   node tools/make-template.js
 */

const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WB = path.join(ROOT, 'config', '邮件配置.xlsx');

const TYPE_HEADERS = ['类型名称', '主题格式', '发件人显示名', '关联平台', '备注', '正文MD'];
const PLATFORM_HEADERS = ['平台名称', '收件邮箱', '抄送', '密送', '附件', '启用', '对接联系人'];

const NOTE_FONT = { color: { argb: 'FF888888' }, italic: true, size: 10 };
function styleHeader(ws, widths) {
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.alignment = { vertical: 'middle', wrapText: true };
  widths.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });
}

function main() {
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

  // ---------- 1. 类型 ----------
  const ts = wb.addWorksheet('类型');
  ts.addRow(TYPE_HEADERS);
  ts.addRow([
    '示例类型A',
    '【{平台名称}】投诉处理单_{日期}',
    '示例发件名',
    '全部',
    '这是示例，删掉本行即可',
    '# 标题\n这是 **Markdown** 正文示例，支持 {平台名称} 变量。\n\n- 要点一\n- 要点二',
  ]);
  ts.addRow([
    '示例类型B',
    '先行引导：海峡银行（{平台名称}）：{对接联系人} ，针对客户投诉情况……',
    '',
    '示例平台A,示例平台B',
    '',
    '老师，请辛苦协助处理……\n针对客户投诉情况，如核查存在暴力催收行为，应在3个工作日内告知我行。',
  ]);
  styleHeader(ts, [16, 46, 14, 20, 22, 50]);
  ts.getCell('G1').value = '← 关联平台填「全部」或逗号分隔的平台名称；正文MD 支持 Markdown。';
  ts.getCell('G1').font = NOTE_FONT;

  // ---------- 2. 平台 ----------
  const ps = wb.addWorksheet('平台');
  ps.addRow(PLATFORM_HEADERS);
  ps.addRow(['示例平台A', 'a@example.com', 'leader@example.com', '', '报表A.xlsx', '是', '张三']);
  ps.addRow(['示例平台B', 'b@example.com', '', '', '报表B.xlsx;说明.pdf', '是', '李四']);
  styleHeader(ps, [16, 30, 26, 20, 30, 8, 14]);
  ps.getCell('H1').value = '← 对接联系人会自动成为 {对接联系人} 变量；附件多值用英文分号分隔。';
  ps.getCell('H1').font = NOTE_FONT;

  fs.mkdirSync(path.dirname(WB), { recursive: true });
  wb.xlsx.writeFile(WB).then(() => {
    console.log(`模板已生成 → ${WB}`);
    console.log('提示：正文用 Markdown 写，发送时自动渲染成 HTML。变量用 {名称}，如 {平台名称}。');
  });
}

main();
