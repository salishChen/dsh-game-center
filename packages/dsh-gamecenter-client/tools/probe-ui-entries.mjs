/**
 * 全量列出目标 DSH 里**所有** UI 入口注册项（sidebar.panellist / main / settings 等），
 * 用于定位用户在界面上看到的「技能中心」到底是哪一项。
 *
 * 不做猜测：只把每个注册项的 插槽 / id / order / label 来源 / 所属包 打出来，
 * 由证据决定游戏中心该放哪里。
 *
 * 用法：node tools/probe-ui-entries.mjs [asarPath]
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
  for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name, out);
  return out;
}

function readFile(entry) {
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset);
  return buf.toString('utf8');
}

const files = walk(header).filter((f) => f.path.endsWith('/client.js'));
const rows = [];

for (const file of files) {
  let text;
  try {
    text = readFile(file);
  } catch {
    continue;
  }
  const pkg = (file.path.match(/@deepseek-ai\/([^/]+)/) ?? [])[1] ?? file.path;

  // 抓 slots.inject("<slot>", ... register({ name:"<slot>", ... });
  const re = /slots\.inject\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const slot = m[1];
    const win = text.slice(m.index, m.index + 700);
    const nameMatch = win.match(/name:\s*"([^"]+)"/);
    const idMatch = win.match(/(?:id|key):\s*([^,\n}]+)/);
    const orderMatch = win.match(/order:\s*([^,\n}]+)/);
    const labelMatch = win.match(/label:\s*\(\)\s*=>\s*([^,\n}]+)/);

    rows.push({
      pkg,
      slot,
      name: nameMatch ? nameMatch[1] : '',
      id: idMatch ? idMatch[1].trim() : '',
      order: orderMatch ? orderMatch[1].trim() : '',
      label: labelMatch ? labelMatch[1].trim() : '',
    });
  }
}

const bySlot = new Map();
for (const row of rows) {
  if (!bySlot.has(row.slot)) bySlot.set(row.slot, []);
  bySlot.get(row.slot).push(row);
}

const interesting = ['sidebar.panellist', 'sidebar.footer.action', 'shell.overlay', 'shell.bottom', 'rightbar', 'main'];
for (const slot of interesting) {
  const list = bySlot.get(slot);
  if (list === undefined) continue;
  console.log(`\n### ${slot}（${list.length} 项）`);
  const seen = new Set();
  for (const row of list) {
    const key = `${row.pkg}|${row.id}|${row.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  - [${row.pkg}] name=${row.name} id=${row.id} order=${row.order} label=${row.label}`);
  }
}

console.log('\n### 其余插槽（仅列名字，便于找候选位置）');
for (const [slot, list] of bySlot) {
  if (interesting.includes(slot)) continue;
  const pkgs = [...new Set(list.map((r) => r.pkg))];
  console.log(`  ${slot}: ${pkgs.join(', ')}`);
}

fs.closeSync(fd);
