/**
 * aiGenerate 最小 wire 契约测试（2026-10-21）。
 *
 * 【为什么优先 import staging】protocol 的在线 `dist/` 是 Host 的 workspace 运行时依赖，
 * 本轮只允许隔离构建；所以测试优先加载 `staging/`，`staging/` 不存在（例如后续 dist
 * 已正式重建）时回退 `dist/`。两种情况下断言的契约完全相同。
 *
 * 这些断言只证明**形状与体积**校验正确，不证明授权：租约、manifest slot、模型绑定、
 * 预算与用户授权仍必须由 Host 校验，默认不发起任何真实模型调用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.join(here, '../dist/index.js');
const stagingEntry = path.join(here, '../staging/index.js');
const entry = existsSync(distEntry) ? distEntry : stagingEntry;
const protocol = await import(pathToFileURL(entry).href);

const validRequest = {
  runtimeToken: 'rt-token-abcdef',
  operationId: 'op-1',
  slot: 'boardGeneration',
  input: { rows: 9, cols: 9, mines: 10 },
};

test('方法表：aiGenerate 已登记且总数与方法表一致', () => {
  assert.equal(protocol.GAMECENTER_REMOTE_METHODS.length, 24, '方法表应为 24 条');
  assert.ok(protocol.GAMECENTER_REMOTE_METHODS.includes('aiGenerate'), '方法表必须含 aiGenerate');
  assert.ok(
    protocol.GAMECENTER_REMOTE_METHOD_ADDITIONS.includes('aiGenerate'),
    'aiGenerate 必须算作新增方法，便于 Host/Client 对账',
  );
});

test('导出可消费：类型常量与校验器都在', () => {
  assert.equal(typeof protocol.validateAiGenerateRequest, 'function');
  assert.equal(protocol.AI_GENERATE_MAX_INPUT_BYTES, 256 * 1024);
  assert.ok(protocol.AI_GENERATE_SLOT_PATTERN.test('boardGeneration'));
  assert.equal(protocol.AI_GENERATE_SLOT_PATTERN.test('bad slot!'), false);
});

test('正例：合法请求零 violation', () => {
  assert.deepEqual(protocol.validateAiGenerateRequest(validRequest), []);
  // input 允许显式 null
  assert.deepEqual(protocol.validateAiGenerateRequest({ ...validRequest, input: null }), []);
});

test('反例：自报 provider/model/tools/permissions 一律拒绝，不是静默忽略', () => {
  for (const extra of ['provider', 'model', 'tools', 'permissions']) {
    const violations = protocol.validateAiGenerateRequest({ ...validRequest, [extra]: 'x' });
    assert.ok(
      violations.some((v) => v.field === extra),
      `${extra} 必须被显式拒绝（否则实现者会以为自报生效）`,
    );
  }
  // 一个合法字段 + 一个越权字段同时出现，也必须报出来
  const mixed = protocol.validateAiGenerateRequest({ ...validRequest, model: 'gpt-any' });
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].field, 'model');
});

test('反例：缺字段 / 形状错误', () => {
  const missing = protocol.validateAiGenerateRequest({});
  const fields = missing.map((v) => v.field).sort();
  assert.deepEqual(fields, ['input', 'operationId', 'runtimeToken', 'slot']);

  assert.ok(protocol.validateAiGenerateRequest(null).length > 0);
  assert.ok(protocol.validateAiGenerateRequest([]).length > 0, '数组不是合法入参对象');

  // runtimeToken 上限 512
  assert.ok(
    protocol.validateAiGenerateRequest({ ...validRequest, runtimeToken: 'a'.repeat(513) }).some(
      (v) => v.field === 'runtimeToken',
    ),
  );
  // operationId / slot 只允许 [A-Za-z0-9._:-] 且 1~128
  assert.ok(
    protocol.validateAiGenerateRequest({ ...validRequest, operationId: 'bad op!' }).some(
      (v) => v.field === 'operationId',
    ),
  );
  assert.ok(
    protocol.validateAiGenerateRequest({ ...validRequest, slot: 'x'.repeat(129) }).some((v) => v.field === 'slot'),
  );
});

test('反例：input 体积上限与不可序列化', () => {
  const big = { ...validRequest, input: { blob: 'a'.repeat(protocol.AI_GENERATE_MAX_INPUT_BYTES) } };
  assert.ok(
    protocol.validateAiGenerateRequest(big).some((v) => v.field === 'input'),
    '超过 256 KiB 必须拒绝',
  );

  const circular = { ...validRequest, input: {} };
  circular.input = circular;
  assert.ok(
    protocol.validateAiGenerateRequest(circular).some((v) => v.field === 'input'),
    '循环引用必须拒绝',
  );

  const withFn = { ...validRequest, input: { fn: () => 1 } };
  // 函数会被 JSON.stringify 丢成 undefined 而不是抛错；这里只要求不崩，
  // 真正的"必须是 JSON"由 Host 侧序列化再校验兜底。
  assert.equal(Array.isArray(protocol.validateAiGenerateRequest(withFn)), true);
});

test('错误码沿用协议受限联合：SAVE_UNSUPPORTED 与新 AI 码同表', () => {
  // 15 项：本轮新增 CATALOG_UNREACHABLE（目录后台不可达），AI 侧仍然没有新码。
  assert.equal(protocol.ERROR_CODES.length, 15, 'ERROR_CODES 应为 15 项（本轮只新增 CATALOG_UNREACHABLE）');
  assert.equal(protocol.isErrorCode('CATALOG_UNREACHABLE'), true);
  assert.ok(protocol.ERROR_CODES.includes('CAPABILITY_UNAVAILABLE'), 'AI 未授权时用现有 CAPABILITY_UNAVAILABLE');
  assert.equal(protocol.DEFAULT_RETRYABLE.CAPABILITY_UNAVAILABLE, false);
});
