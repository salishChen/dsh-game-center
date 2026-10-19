/**
 * 逐字段核实 `ctx.remote.$mount()` 接受外部 contribution 的**完整形状要求**。
 *
 * 只读安装包，不改任何东西。输出分三部分：
 *   1. gateway 的 `$mount` → `mountContribution` → `validateContribution` 里真正读取的字段
 *   2. typert registry 的 `remotes.register(contribution)` 里要求但 gateway 不提供的字段
 *   3. 两份要求是否兼容 —— 这决定手写 contribution 是否可行
 *
 * 用法：node tools/probe-remote-shape.mjs [asarPath]
 */

import fs from 'node:fs';

const ASAR =
  process.argv[2] ??
  'D:\\Program Files\\deepseek harness\\resources\\app.asar';

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
 * 抽取一个函数体（按大括号配对），用来逐字段读它**实际读取**的属性。
 * @param {string} text
 * @param {string} signature 例如 'function validateContribution('
 * @returns {string | null}
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

/**
 * 该方法体内读取的所有 `x.prop` 属性名。
 * @param {string} body
 * @param {string} root 变量名
 * @returns {string[]}
 */
function propsOf(body, root) {
  const re = new RegExp(`\\b${root.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g');
  const out = new Set();
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out].sort();
}

const report = [];
const log = (line = '') => report.push(line);

log('=== 1. dsh-api-gateway/lib/client.browser.js ===');
const gw = readPath('dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js');

const mount = extractFunction(gw, 'async mountContribution(');
log(`mountContribution 找到: ${mount !== null}`);
if (mount !== null) {
  log(`  读取 contribution.* : ${propsOf(mount, 'contribution').join(', ') || '(无)'}`);
}

const validate = extractFunction(gw, 'validateContribution(');
log(`validateContribution 找到: ${validate !== null}`);
if (validate !== null) {
  log(`  读取 contribution.* : ${propsOf(validate, 'contribution').join(', ') || '(无)'}`);
  log(`  读取 descriptor.*   : ${propsOf(validate, 'descriptor').join(', ') || '(无)'}`);
}

const mdeps = extractFunction(gw, 'function mountDependencies(');
if (mdeps !== null) log(`mountDependencies 读取 contribution.*: ${propsOf(mdeps, 'contribution').join(', ')}`);

log();
log('=== 2. dsh-typert-registry/lib/client.browser.js ===');
const reg = readPath('dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/client.browser.js');

const regFn = extractFunction(reg, 'register(contribution)');
log(`remotes.register 找到: ${regFn !== null}`);
if (regFn !== null) {
  log(`  读取 contribution.* : ${propsOf(regFn, 'contribution').join(', ') || '(无)'}`);
}

const vp = extractFunction(reg, 'validatePackage(contribution)');
if (vp !== null) {
  log(`  validatePackage 读取 contribution.* : ${propsOf(vp, 'contribution').join(', ')}`);
}

const vs = extractFunction(reg, 'validateSchemas(contribution)');
if (vs !== null) {
  log(`  validateSchemas 读取 contribution.* : ${propsOf(vs, 'contribution').join(', ')}`);
}

log();
log('=== 3. 结构差异判定 ===');
const gwNeeds = new Set([...(mount ? propsOf(mount, 'contribution') : []), ...(validate ? propsOf(validate, 'contribution') : [])]);
const regNeeds = regFn ? propsOf(regFn, 'contribution') : [];
const onlyRegistry = regNeeds.filter((p) => !gwNeeds.has(p));
log(`gateway 需要: ${[...gwNeeds].join(', ') || '(无)'}`);
log(`registry 需要: ${regNeeds.join(', ') || '(无)'}`);
log(`仅 registry 要求: ${onlyRegistry.join(', ') || '(无)'}`);
log(`判定: ${onlyRegistry.length === 0 ? '形状兼容' : `形状不兼容 —— 手写 contribution 必须额外提供 ${onlyRegistry.join(', ')}`}`);

const text = report.join('\n');
console.log(text);
fs.closeSync(fd);
