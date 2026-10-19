/**
 * 【一致性守卫】Client descriptor ↔ Host wire 契约。
 *
 * 项目经理要求：送验前补一致性检查，避免「为解决构建依赖而形成两套漂移契约」。
 *
 * 背景：同一份 wire 契约现在有三处表述——
 *   1. `packages/protocol`（共享协议，理想真相源）
 *   2. `packages/dsh-gamecenter/src/remote/game-center-service.ts`（Host 用**本地结构子集**
 *      声明，以切断对 protocol 的编译期依赖）
 *   3. `packages/dsh-gamecenter-client/src/bridge/remote-mount.js`（Client descriptor，
 *      浏览器 bundle 不能依赖 protocol）
 *
 * 本测试调 `tools/check-wire-contract.mjs`，从 Host 源码静态解析出命名空间、服务键、
 * 五方法 wire 形参名与顺序、cancellation 有无，再与 Client contribution 逐项比对。
 *
 * 边界：**源码静态解析，不是类型检查，也不是运行时验证。**
 * Host 侧若大幅重写 interface，本检查会报解析失败而不是静默通过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const hostService = path.join(repoRoot, 'packages', 'dsh-gamecenter', 'src', 'remote', 'game-center-service.ts');
const script = path.join(here, '..', 'tools', 'check-wire-contract.mjs');

test('Client descriptor 与 Host 服务的 wire 契约一致', (t) => {
  if (!existsSync(hostService)) {
    // Host 包不在本工作区时跳过并打印原因，不伪通过。
    t.skip(`Host 服务源码不存在：${hostService}`);
    return;
  }

  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  assert.equal(
    result.status,
    0,
    `check-wire-contract 失败（exit ${String(result.status)}）：\n${output}`,
  );
  assert.match(output, /RESULT=PASS/, '输出必须明确 PASS');
  // 防止脚本自身解析失败被当成"没有差异"
  assert.match(output, /Host 方法: .*handshake/, 'Host 方法列表必须解析成功');
});
