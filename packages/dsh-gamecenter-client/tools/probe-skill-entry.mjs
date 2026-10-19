/**
 * 找出「技能中心」在 UI 里的真实入口位置——它是哪个插件、注册进哪个插槽。
 *
 * 目的：用户要求游戏中心入口放在技能中心附近。在改动任何 Client 文件之前，
 * 必须先用证据确定「技能中心」到底是哪个槽位里的哪个注册项，
 * 而不是凭想象放到 sidebar.panellist。
 *
 * 做法：遍历 asar 内所有 client bundle，找注册了与 skill 相关的 slot 项，
 * 并打印其 name / id / key / order，以及它所属的父 slot。
 *
 * 用法：node tools/probe-skill-entry.mjs [asarPath]
 */

import fs from 'node:fs';

const ASAR = process.argv[2] ?? 'D:\\Program Files\\deepseek harness\\resources\\app.asar';

const fd = fs.openSync(ASAR, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const base = 16 + jsonLen;

function walk(node, prefix = '', out = []) {
  if (!node.files) {
    out.push({ path: prefix, size: node.size, offset: Number(node.offset) });
    return out;
  }
  for (const [name, child] of Object.entries(node.files)) {
    walk(child, prefix ? `${prefix}/${name}` : name, out);
  }
  return out;
}

function readFile(entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset);
  return buf.toString('utf8');
}

const files = walk(header).filter((f) => f.path.endsWith('/client.js'));
console.log(`扫描 ${files.length} 个 client bundle...\n`);

/** @type {{pkg: string, file: string, snippet: string}[]} */
const hits = [];

for (const file of files) {
  let text;
  try {
    text = readFile(file);
  } catch {
    continue;
  }
  if (!/skill/i.test(text)) continue;

  // 找所有 ctx.slots.register / slots.inject 附近的 skill 字样
  const re = /name:\s*"([^"]+)"[^]{0,400}?(?:"(?:id|key)":\s*"([^"]*skill[^"]*)"|(?:id|key):\s*"([^"]*skill[^"]*)"|label|order)/gi;
  const pkg = (file.path.match(/@deepseek-ai\/([^/]+)/) ?? [])[1] ?? file.path;

  // 更直接：抓每一处 slots.inject("<slot>") 之后紧跟的 register 块
  const injectRe = /slots\.inject\(\s*"([^"]+)"/g;
  let m;
  while ((m = injectRe.exec(text)) !== null) {
    const slotName = m[1];
    const window = text.slice(m.index, m.index + 900);
    if (!/skill/i.test(window)) continue;
    const regName = window.match(/name:\s*"([^"]+)"/);
    const regKey = window.match(/(?:key|id):\s*"([^"]+)"/);
    const order = window.match(/order:\s*([\w.]+)/);
    const priority = window.match(/priority:\s*([\w.]+)/);
    hits.push({
      pkg,
      file: file.path,
      snippet: [
        `注入插槽: ${slotName}`,
        regName === null ? null : `注册 name: ${regName[1]}`,
        regKey === null ? null : `id/key: ${regKey[1]}`,
        order === null ? null : `order: ${order[1]}`,
        priority === null ? null : `priority: ${priority[1]}`,
      ]
        .filter(Boolean)
        .join('  |  '),
    });
  }
}

if (hits.length === 0) {
  console.log('未发现 slots.inject 中含 skill 的注册。');
} else {
  for (const hit of hits) console.log(`[${hit.pkg}] ${hit.snippet}\n    ${hit.file}\n`);
}

console.log('=== 另查：sidebar.panellist 的所有现有注册项（判断哪一项是技能中心）===');
for (const file of files) {
  let text;
  try {
    text = readFile(file);
  } catch {
    continue;
  }
  if (!text.includes('sidebar.panellist')) continue;
  const pkg = (file.path.match(/@deepseek-ai\/([^/]+)/) ?? [])[1] ?? file.path;
  const idx = text.indexOf('sidebar.panellist');
  console.log(`[${pkg}] ${file.path}`);
  console.log(`    …${text.slice(Math.max(0, idx - 300), idx + 300).replace(/\s+/g, ' ')}…\n`);
}

fs.closeSync(fd);
