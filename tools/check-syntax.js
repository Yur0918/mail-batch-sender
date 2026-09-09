'use strict';

/**
 * 构建检查:本项目为纯 JavaScript、无需编译,
 * "build" 定义为全量语法解析检查(只 parse 不执行,无任何副作用)。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const TARGETS = ['send.js', 'server.js', 'lib', 'tools', 'tests'];

const files = [];
for (const t of TARGETS) {
  const p = path.join(root, t);
  if (!fs.existsSync(p)) continue;
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p)) {
      if (f.endsWith('.js')) files.push(path.join(p, f));
    }
  } else {
    files.push(p);
  }
}

let failed = 0;
for (const f of files) {
  const rel = path.relative(root, f);
  try {
    new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
    console.log(`ok    ${rel}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${rel} :: ${err.message}`);
  }
}

if (failed) {
  console.error(`\n语法检查失败:${failed} 个文件`);
  process.exit(1);
}
console.log(`\n语法检查通过:${files.length} 个文件`);
