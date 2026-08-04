'use strict';

/**
 * Markdown -> HTML 渲染。
 * 正文用 Markdown 写，发送时渲染成 HTML 邮件正文（排版更好看）。
 * html:false 关闭原始 HTML 注入，避免模板里的尖括号被当成标签。
 */

const MarkdownIt = require('markdown-it');
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

function render(markdown, opts = {}) {
  let html = md.render(String(markdown || ''));
  if (opts.email) {
    html =
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,' +
      '\'PingFang SC\',\'Microsoft YaHei\',sans-serif;line-height:1.7;color:#1f2329;' +
      'font-size:14px;">' +
      html +
      '</div>';
  }
  return html;
}

module.exports = { render };
