/**
 * 核实 typert 侧 `RemoteStore.validate()` 的**完整**必填字段集。
 *
 * 背景：架构负责人指出 `validateInvocation` 要求 `id` / `service`，
 * 并要求 `validateCodec` 在 `mode:"src-json"` 时放行。这与我的实现（只有
 * namespace/method/invocation/parameters/result）不一致 —— 必须逐条核实到底。
 *
 * 用法：node tools/probe-typert-rules.mjs [asarPath]
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

/** 按大括号配对取函数体。 */
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

/** 从 body 里抽出 `validateXxx("label", descriptor.prop)` 之类调用读到的字段。 */
function descriptorFields(body) {
  const out = new Set();
  const re = /descriptor\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out].sort();
}

const reg = readPath('dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/client.browser.js');
const gw = readPath('dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js');

console.log('=== A. typert validateInvocation 读取的 descriptor 字段 ===');
const vi = extractFunction(reg, 'function validateInvocation(');
console.log(vi === null ? '(未找到)' : descriptorFields(vi).join(', '));
if (vi !== null) {
  // 打印关键行，便于人工核对必填项
  for (const line of vi.split('\n')) {
    const t = line.trim();
    if (t.startsWith('validate') || t.startsWith('if (')) console.log('   ', t.slice(0, 160));
  }
}

console.log();
console.log('=== B. typert validateCodec 的放行规则 ===');
const vc = extractFunction(reg, 'function validateCodec(');
console.log(vc === null ? '(未找到)' : vc.replace(/\s+/g, ' ').slice(0, 700));

console.log();
console.log('=== C. gateway requireStrictCodec 的放行规则 ===');
const rc = extractFunction(gw, 'function requireStrictCodec(');
console.log(rc === null ? '(未找到)' : rc.replace(/\s+/g, ' ').slice(0, 400));

console.log();
console.log('=== D. RemoteStore.register 是否调用 descriptors.validate ===');
const rr = extractFunction(reg, 'register(ctx, contribution)');
console.log(rr === null ? '(未找到)' : rr.replace(/\s+/g, ' ').slice(0, 600));

fs.closeSync(fd);
