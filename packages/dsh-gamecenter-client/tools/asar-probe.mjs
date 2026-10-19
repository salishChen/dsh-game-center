/**
 * 只读探针：按路径读取安装包 app.asar 内的文件文本，用于核验目标 DSH 的
 * Client 装配与 slots/overlay 真实入口。**不修改安装目录**，只 open(...,'r')。
 *
 * 用法：
 *   node tools/asar-probe.mjs <asarPath> <innerPath> [needle]
 *   node tools/asar-probe.mjs <asarPath> --list <prefix>      列出前缀下的文件
 */
import fs from 'node:fs';
import path from 'node:path';

const [asarPath, ...rest] = process.argv.slice(2);
if (!asarPath) {
  console.error('usage: node tools/asar-probe.mjs <asarPath> <innerPath> [needle] | --list <prefix>');
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

/** @param {string} inner */
function readInner(inner) {
  let cur = header;
  for (const part of inner.split('/')) {
    cur = cur?.files?.[part];
    if (!cur) throw new Error(`not found in asar: ${inner}`);
  }
  const buf = Buffer.alloc(cur.size);
  fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset));
  return buf.toString('utf8');
}

/** @param {any} node @param {string} prefix */
function listAll(node, prefix = '') {
  if (!node.files) return [prefix];
  /** @type {string[]} */
  const out = [];
  for (const [name, child] of Object.entries(node.files)) {
    out.push(...listAll(child, prefix ? `${prefix}/${name}` : name));
  }
  return out;
}

try {
  if (rest[0] === '--list') {
    const prefix = rest[1] ?? '';
    for (const file of listAll(header)) {
      if (file.startsWith(prefix)) console.log(file);
    }
  } else {
    const [inner, needle] = rest;
    if (!inner) throw new Error('missing innerPath');
    const text = readInner(inner);
    if (needle === undefined) {
      process.stdout.write(text);
    } else {
      const at = text.indexOf(needle);
      if (at === -1) {
        console.log(`NOT FOUND: ${needle} in ${path.basename(inner)} (len=${text.length})`);
        process.exitCode = 1;
      } else {
        console.log(`FOUND at ${at}`);
        console.log(text.slice(Math.max(0, at - 300), at + 600));
      }
    }
  }
} finally {
  fs.closeSync(fd);
}
