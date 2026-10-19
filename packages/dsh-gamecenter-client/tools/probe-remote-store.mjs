/**
 * 复核 `ctx.typert.remotes.register()`（RemoteStore 分支）的真实契约。
 *
 * 【为什么重写这个探针】
 * 第一版 `probe-remote-shape.mjs` 用 `extractFunction(reg, 'register(contribution)')`
 * 抓到了 **TypertRegistry 自身的** `register(contribution)`（那是 `typert.local`/包面注册，
 * 读 `invocations`），而 `ctx.typert.remotes` 实际是 `RemoteStore`，它暴露的是
 * `register(ctx, contribution)`。**抓错分支 → 得出错误结论。** 这正对应组内纪律
 * 「证据必须指出哪个文件的哪个结构」，第一条更要做到「哪个类的哪个方法」。
 *
 * 用法：node tools/probe-remote-store.mjs [asarPath]
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

function readPath(inner) {
  let cur = header;
  for (const part of inner.split('/')) {
    cur = cur?.files?.[part];
    if (!cur) throw new Error(`not found in asar: ${inner}`);
  }
  const buf = Buffer.alloc(cur.size);
  fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset));
  return buf.toString('utf8');
}

/**
 * 从 `signature` 处起，按大括号配对取出方法体。
 * @param {string} text @param {string} signature @returns {string | null}
 */
function extractFunction(text, signature) {
  const start = text.indexOf(signature);
  if (start === -1) return null;
  let depth = 0;
  let began = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      began = true;
    } else if (ch === '}') {
      depth -= 1;
      if (began && depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 方法体内对 `root.prop` 的读取。 */
function propsOf(body, root) {
  const re = new RegExp(`\\b${root.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out].sort();
}

const reg = readPath('dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/client.browser.js');

console.log('=== typert.remotes 的真实来源 ===');
const remotesGetter = extractFunction(reg, 'get remotes()');
console.log('get remotes() 体:', remotesGetter?.replace(/\s+/g, ' ').slice(0, 200));

console.log();
console.log('=== RemoteStore.view() 暴露的 register ===');
const view = extractFunction(reg, 'view(ctx)');
const viewAt = view === null ? -1 : reg.lastIndexOf('view(ctx)', reg.indexOf('register(ctx, contribution)'));
console.log('确认 register 签名: register(ctx, contribution) →', reg.includes('register(ctx, contribution)'));

console.log();
console.log('=== RemoteStore.register(ctx, contribution) 实际读取的字段 ===');
const remoteRegister = extractFunction(reg, 'register(ctx, contribution)');
if (remoteRegister === null) {
  console.log('未找到');
} else {
  const flat = remoteRegister.replace(/\s+/g, ' ');
  console.log('contribution 读取:', propsOf(remoteRegister, 'contribution').join(', ') || '(无)');
  console.log('是否读 invocations:', /\binvocations\b/.test(flat));
  console.log('是否读 descriptors :', /\bdescriptors\b/.test(flat));
  console.log('是否读 schemas     :', /\bschemas\b/.test(flat));
  console.log('是否读 face        : /\bface\b/    test →', /\bface\b/.test(flat));
}

console.log();
console.log('=== 对照：TypertRegistry.register(contribution)（另一条分支，与 remotes 无关）===');
const packageRegister = extractFunction(reg, 'register(contribution)');
if (packageRegister !== null) {
  console.log('contribution 读取:', propsOf(packageRegister, 'contribution').join(', '));
  console.log('说明: 这是包面/schema 注册，不是 ctx.typert.remotes.register 的实现。');
}

fs.closeSync(fd);
