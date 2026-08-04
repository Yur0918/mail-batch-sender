'use strict';

/**
 * 模板变量替换。
 * 占位符统一写作 {变量名}，变量来源优先级：
 *   1. 收件方 sheet 的列（列名即变量名）
 *   2. 内置日期时间变量
 * 未能替换的占位符会被收集起来，由调用方决定是否拒发。
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateCn(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 生成内置变量表。
 * @param {Date} [now]
 */
function builtinVars(now = new Date()) {
  const yesterday = new Date(now.getTime() - 86400000);
  const tomorrow = new Date(now.getTime() + 86400000);
  return {
    日期: fmtDate(now),
    日期中文: fmtDateCn(now),
    昨日: fmtDate(yesterday),
    昨日中文: fmtDateCn(yesterday),
    明日: fmtDate(tomorrow),
    年份: String(now.getFullYear()),
    月份: pad(now.getMonth() + 1),
    日: pad(now.getDate()),
    年月: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
    星期: `星期${WEEKDAY_CN[now.getDay()]}`,
    时间: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    时间戳: `${fmtDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

const PLACEHOLDER = /\{([^{}\r\n]+)\}/g;

/**
 * 替换字符串中的占位符。
 * @returns {{ text: string, missing: string[] }}
 */
function render(template, vars) {
  const missing = new Set();
  if (template === undefined || template === null) {
    return { text: '', missing: [] };
  }
  const text = String(template).replace(PLACEHOLDER, (match, name) => {
    const key = name.trim();
    const value = vars[key];
    if (value === undefined || value === null || value === '') {
      missing.add(key);
      return match;
    }
    return String(value);
  });
  return { text, missing: [...missing] };
}

/** 列出模板里用到的所有变量名 */
function extractVars(template) {
  const found = new Set();
  if (!template) return [];
  for (const m of String(template).matchAll(PLACEHOLDER)) {
    found.add(m[1].trim());
  }
  return [...found];
}

module.exports = { render, extractVars, builtinVars, fmtDate, fmtDateCn };
