#!/usr/bin/env node
'use strict';

/**
 * 写入 SMTP 账号到共享配置 ~/.config/mail-skills/.env（与 imap-smtp-email 技能共用）
 *
 *   node tools/set-account.js --provider 126 --user me@126.com --pass 授权码
 *   node tools/set-account.js --provider 163 --user work@163.com --pass 授权码 --account WORK
 *
 * 凭据只写到用户 home 下的配置文件（权限 600），绝不落到项目目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PROVIDERS } = require('../lib/config');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'mail-skills');
const CONFIG_FILE = path.join(CONFIG_DIR, '.env');

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return opts;
}

function usage() {
  console.log(`
写入 SMTP 发件账号

  node tools/set-account.js --provider <服务商> --user <邮箱> --pass <授权码> [选项]

必填
  --provider   ${Object.keys(PROVIDERS).join(' / ')}
  --user       完整邮箱地址
  --pass       授权码（网易/QQ 都不是登录密码）

可选
  --from-name  发件人显示名（默认不设，用渠道配置里的）
  --account    账户别名，多账号时用；写入时加大写前缀，发信用 --account 指定
  --show       只打印当前配置（密码打码），不修改

网易系授权码获取：网页版邮箱 → 设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 新增授权密码
`);
}

function readExisting() {
  if (!fs.existsSync(CONFIG_FILE)) return '';
  return fs.readFileSync(CONFIG_FILE, 'utf8');
}

function maskLine(line) {
  return line.replace(/^((?:[A-Z0-9_]+_)?(?:PASSWORD|SMTP_PASS))=.*/, (_m, k) => `${k}=****`);
}

function upsert(text, key, value) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp(`^${key}=`);
  let found = false;
  const out = lines.map((l) => {
    if (re.test(l.trim())) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) out.push(`${key}=${value}`);
  return out.join('\n');
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || opts.h) return usage();

  if (opts.show) {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.log(`\n配置文件不存在：${CONFIG_FILE}\n`);
      return;
    }
    console.log(`\n${CONFIG_FILE}\n`);
    console.log(
      readExisting()
        .split(/\r?\n/)
        .map(maskLine)
        .join('\n')
    );
    return;
  }

  const { provider, user, pass } = opts;
  const missing = [];
  if (!provider || provider === true) missing.push('--provider');
  if (!user || user === true) missing.push('--user');
  if (!pass || pass === true) missing.push('--pass');
  if (missing.length) {
    console.error(`\n缺少参数：${missing.join(' ')}`);
    usage();
    process.exitCode = 1;
    return;
  }

  const key = String(provider).toLowerCase();
  if (!PROVIDERS[key]) {
    console.error(
      `\n未知服务商「${provider}」。支持：${Object.keys(PROVIDERS).join(', ')}\n` +
        `如需自定义，直接编辑 ${CONFIG_FILE} 里的 SMTP_HOST / SMTP_PORT / SMTP_SECURE。\n`
    );
    process.exitCode = 1;
    return;
  }

  const preset = PROVIDERS[key];
  const domain = String(user).split('@')[1] || '';
  if (domain && !preset.host.includes(domain.replace(/^mail\./, ''))) {
    console.log(`⚠ 邮箱域名「${domain}」与服务商预设「${preset.host}」看起来不匹配，请确认。`);
  }

  const prefix = opts.account && opts.account !== true ? `${String(opts.account).toUpperCase()}_` : '';

  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let text = readExisting();
  if (text && !text.endsWith('\n')) text += '\n';

  text = upsert(text, `${prefix}PROVIDER`, key);
  text = upsert(text, `${prefix}SMTP_HOST`, preset.host);
  text = upsert(text, `${prefix}SMTP_PORT`, String(preset.port));
  text = upsert(text, `${prefix}SMTP_SECURE`, String(preset.secure));
  text = upsert(text, `${prefix}USERNAME`, user);
  text = upsert(text, `${prefix}PASSWORD`, pass);
  text = upsert(text, `${prefix}SMTP_FROM`, user);

  fs.writeFileSync(CONFIG_FILE, text.replace(/\n{3,}/g, '\n\n'), { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);

  console.log(`
账号已写入 ${CONFIG_FILE}（权限 600）

  服务商 : ${key}
  SMTP   : ${preset.host}:${preset.port} (secure=${preset.secure})
  账号   : ${user}
  密码   : **** (${String(pass).length} 位)
  ${prefix ? `别名   : ${opts.account}（发信时加 --account ${opts.account}）` : ''}

下一步，发一封测试信验证连通性：
  node send.js test --to 你的另一个邮箱@qq.com
`);
}

main();
