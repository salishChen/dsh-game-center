/**
 * 在 app.asar 内做「多 needles 位置检索」，用于快速定位真实装配点。
 * 用法：node tools/asar-grep.mjs <asarPath> <innerPath> <needle> [needle...]
 */
import fs from 'node:fs';

const [asarPath, innerPath, ...needles] = process.argv.slice(2);
if (!asarPath || !innerPath || needles.length === 0) {
  console.error('usage: node tools/asar-grep.mjs <asarPath> <innerPath> <needle> [needle...]');
  process.exit(2);
}

const fd = fs.openSync(asarPath, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString('utf8'));
const base = 16 + jsonLen;

let node = header;
for (const part of innerPath.split('/')) {
  node = node?.files?.[part];
  if (!node) {
    console.error(`not found in asar: ${innerPath}`);
    process.exit(3);
  }
}
const buf = Buffer.alloc(node.size);
fs.readSync(fd, buf, 0, node.size, base + Number(node.offset));
fs.closeSync(fd);
const text = buf.toString('utf8');

for (const needle of needles) {
  let at = -1;
  let count = 0;
  while ((at = text.indexOf(needle, at + 1)) !== -1) {
    count += 1;
    if (count <= 2) {
      console.log(`--- ${needle} @${at}`);
      console.log(text.slice(Math.max(0, at - 200), at + 400).replace(/\n/g, '\n  '));
    }
  }
  console.log(`=== ${needle}: ${count} hit(s), len=${text.length}`);
}
