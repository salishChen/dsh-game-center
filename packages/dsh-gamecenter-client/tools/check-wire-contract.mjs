/**
 * 【一致性检查】Client descriptor ↔ Host 服务的 wire 契约。
 *
 * 项目经理要求：为避免为解决构建依赖而形成两套漂移契约，送验前必须补一致性检查。
 *
 * 为什么需要它：Host 包为了切断对 `@dsh-gamecenter/protocol` 的编译期依赖，
 * 在自己包里用**本地结构子集**声明了 wire 形状（见 `game-center-service.ts` 文件头契约表
 * 与 `HandshakeWireInput` 等 interface）；Client 包则完全不能依赖 protocol（浏览器 bundle），
 * 另有一份 descriptor。**同一个契约存在三处表述**，这正是漂移风险。
 *
 * 本检查从 Host 源文件**只读解析**出：命名空间、服务键、五个方法的 wire 形参名与顺序、
 * 哪些方法带 cancellation，再与 Client 的 `createGameCenterContribution()` 逐项比对。
 *
 * 注意边界：这是**源码静态解析**，不是类型检查，也不是运行时验证。
 * Host 侧若把 interface 改成别名或重新组织，本检查会报"解析失败"而不是误判为通过。
 *
 * 用法：node tools/check-wire-contract.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGameCenterContribution } from '../src/bridge/remote-mount.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const hostService = path.join(repoRoot, 'packages', 'dsh-gamecenter', 'src', 'remote', 'game-center-service.ts');
const hostProtocol = path.join(repoRoot, 'packages', 'dsh-gamecenter', 'src', 'dsh-adapter', 'protocol.ts');

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

// —— 1. 读取 Host 的命名空间与服务键 ——
const protocolSrc = readFileSync(hostProtocol, 'utf8');
const nsMatch = protocolSrc.match(/export const REMOTE_NAMESPACE\s*=\s*'([^']+)'/);
const skMatch = protocolSrc.match(/export const SERVICE_KEY\s*=\s*'([^']+)'/);
if (nsMatch === null) fail('无法从 protocol.ts 解析 REMOTE_NAMESPACE');
if (skMatch === null) fail('无法从 protocol.ts 解析 SERVICE_KEY');
const hostNamespace = nsMatch?.[1];
const hostServiceKey = skMatch?.[1];
note(`Host REMOTE_NAMESPACE = ${JSON.stringify(hostNamespace)}`);
note(`Host SERVICE_KEY      = ${JSON.stringify(hostServiceKey)}`);

// —— 2. 解析 Host 服务的公开方法签名 ——
const serviceSrc = readFileSync(hostService, 'utf8');

// 只取 class GameCenterService 的类体
const classStart = serviceSrc.indexOf('class GameCenterService extends Base');
if (classStart === -1) fail('无法定位 GameCenterService 类');
const classBody = serviceSrc.slice(classStart);

/**
 * 从类体里抽取每个公开方法的一行签名。
 * 缩进宽度由 Host 源码决定，这里不假设制表符还是空格。
 * @param {string} body
 * @returns {Map<string, {params: string[]}>}
 */
function parseMethods(body) {
  /** @type {Map<string, {params: string[]}>} */
  const out = new Map();
  // 形如：  handshake(input: HandshakeWireInput): HandshakeWireOutput {
  //        async modelCatalog(signal: AbortSignal): Promise<ModelCatalogResult> {
  // 只匹配「方法名(参数): 返回类型 {」且不是 if/for/while/switch/catch/new 等关键字。
  const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor']);
  const re = /^[ \t]+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*:\s*[^{]+\{\s*$/gm;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (keywords.has(name)) continue;
    const rawParams = m[2].trim();
    /** @type {string[]} */
    const params = rawParams === '' ? [] : rawParams.split(',').map((p) => p.split(':')[0].trim());
    out.set(name, { params });
  }
  return out;
}

const hostMethods = parseMethods(classBody);
note(`Host 方法: ${[...hostMethods.keys()].join(', ')}`);

// —— 3. 解析 REMOTE_METHODS 白名单 ——
const rmMatch = serviceSrc.match(/const REMOTE_METHODS\s*=\s*\[([^\]]+)\]/);
if (rmMatch === null) fail('无法解析 REMOTE_METHODS');
const remoteMethods = rmMatch === null ? [] : [...rmMatch[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
note(`Host REMOTE_METHODS = [${remoteMethods.join(', ')}]`);

// —— 4. 与 Client contribution 比对 ——
const contribution = createGameCenterContribution();
note(`Client package    = ${JSON.stringify(contribution.package)}`);
note(`Client descriptors = [${contribution.descriptors.map((d) => d.method).join(', ')}]`);

const clientByMethod = new Map(contribution.descriptors.map((d) => [d.method, d]));

if (remoteMethods.length === 0) {
  fail('Host REMOTE_METHODS 为空');
}

for (const method of remoteMethods) {
  const host = hostMethods.get(method);
  const client = clientByMethod.get(method);

  if (host === undefined) {
    fail(`${method}: Host 有 REMOTE_METHODS 声明但类里找不到同名方法`);
    continue;
  }
  if (client === undefined) {
    fail(`${method}: Client 缺少对应 descriptor`);
    continue;
  }

  // 4a. namespace
  if (client.namespace !== hostNamespace) {
    fail(`${method}: namespace 不一致 Client=${client.namespace} Host=${hostNamespace}`);
  }

  // 4b. 取消声明 ↔ 最后一个形参是 signal
  const hasSignalParam = host.params.at(-1) === 'signal';
  const clientDeclaresCancellation = client.cancellation !== undefined;
  if (hasSignalParam !== clientDeclaresCancellation) {
    fail(
      `${method}: cancellation 不一致 —— Host 末位形参是 signal=${hasSignalParam}，` +
        `Client 声明 cancellation=${clientDeclaresCancellation}`,
    );
  }

  // 4c. wire 形参名与顺序（signal 不是 wire 参数，需排除）
  const hostWireParams = host.params.filter((p) => p !== 'signal');
  const clientWireParams = [];
  for (const parameter of client.parameters) {
    clientWireParams.push(parameter.wire);
  }
  if (JSON.stringify(hostWireParams) !== JSON.stringify(clientWireParams)) {
    fail(
      `${method}: wire 形参不匹配 Client=[${clientWireParams.join(',')}] Host=[${hostWireParams.join(',')}]`,
    );
  }
}

// —— 5. Client 不能有 Host 未声明的方法 ——
for (const method of clientByMethod.keys()) {
  if (!remoteMethods.includes(method)) {
    fail(`${method}: Client 声明了任务但 Host REMOTE_METHODS 里没有`);
  }
}

// —— 6. 服务键一致性（Client descriptor.service 不过 wire，但两边同名便于对账）——
for (const descriptor of contribution.descriptors) {
  if (descriptor.service !== hostServiceKey) {
    fail(
      `${descriptor.method}: service 命名不一致 Client=${JSON.stringify(descriptor.service)} ` +
        `Host=${JSON.stringify(hostServiceKey)}（不过 wire，但会造成对账歧义）`,
    );
  }
}

// —— 输出 ——
console.log('=== notes ===');
for (const n of notes) console.log('  ' + n);

if (failures.length > 0) {
  console.log('');
  console.log('=== FAILURES ===');
  for (const f of failures) console.log('  ✖ ' + f);
  console.log('');
  console.log(`RESULT=FAIL (${failures.length} 处)`);
  process.exitCode = 1;
} else {
  console.log('');
  console.log('RESULT=PASS —— Client descriptor 与 Host wire 契约一致');
}
