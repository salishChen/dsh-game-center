/**
 * 资源清理 + 关闭路径收敛 的单元测试（node --test，无第三方依赖）。
 *
 * 覆盖验收场景：
 * - 关闭弹层 / Escape / 返回列表 / 租约失效 都走同一个 requestPause，且幂等。
 * - 暂停成功后销毁实例并释放全部资源；超时回落到最近检查点并说明恢复位置。
 * - 旧代次的保存确认被拒绝；暂停后 Bridge 拒绝新请求。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  abandonPause,
  admitBridgeCall,
  completePause,
  createRuntimeLease,
  destroyRuntime,
  openInput,
  requestPause,
  snapshotRuntime,
  PAUSE_TIMEOUT_MS,
} from '../src/runtime/lease.js';
import { createResourceTable } from '../src/runtime/resources.js';
// 直接用协议包的编译产物（dist），避免依赖 src/index.ts 的绕过解析；
// dist 由 `pnpm -r test` 中 protocol 包的 test 脚本先生成。
import { BRIDGE_METHODS } from '../../protocol/dist/index.js';

function newLease() {
  const lease = createRuntimeLease({
    gameId: 'example.probe',
    saveId: 'save-001',
    runtimeInstanceId: 'rt-1',
    nonce: 'nonce-1',
  });
  lease.portBound = true;
  openInput(lease);
  return lease;
}

test('握手前不接受输入：openInput 只在 starting/running 时成功', () => {
  const lease = createRuntimeLease({ gameId: 'g', saveId: 's', runtimeInstanceId: 'r', nonce: 'n' });
  assert.equal(lease.inputOpen, false);
  assert.equal(lease.clockFrozen, true);
  assert.equal(openInput(lease), true);
  assert.equal(lease.state, 'running');
  assert.equal(lease.inputOpen, true);
  assert.equal(lease.clockFrozen, false);
});

test('每条关闭路径都归一到 requestPause，且重复调用不重复计数', () => {
  const lease = newLease();
  const first = requestPause(lease, { reason: 'close' });
  assert.ok(first);
  assert.equal(lease.state, 'pausing');
  assert.equal(lease.inputOpen, false, '进入 Pausing 必须立刻屏蔽输入');
  assert.equal(lease.clockFrozen, true, '进入 Pausing 必须立刻冻结虚拟时钟');

  for (const reason of ['escape', 'back-to-list', 'lease-lost']) {
    assert.equal(requestPause(lease, { reason }), null, `${reason} 不得重复发起暂停`);
  }
  assert.equal(snapshotRuntime(lease).pauseRequests, 1);
});

test('保存确认后进入 paused 并记录 revision；释放资源后账本为空', () => {
  const lease = newLease();
  requestPause(lease, { reason: 'close' });
  const outcome = completePause(lease, { generation: lease.generation, revision: 7 });
  assert.equal(outcome.kind, 'saved');
  assert.equal(outcome.revision, 7);
  assert.match(outcome.message, /r7/);

  const resources = createResourceTable();
  const released = [];
  resources.track('iframe', () => released.push('iframe'));
  resources.track('audio', () => released.push('audio'));
  resources.track('worker', () => released.push('worker'));
  assert.equal(resources.outstanding().count, 3);
  const result = resources.releaseAll();
  assert.equal(result.released, 3);
  assert.deepEqual(released, ['worker', 'audio', 'iframe'], '必须逆序释放');
  assert.deepEqual(resources.outstanding(), { count: 0, kinds: {} });
  assert.equal(resources.releaseAll().released, 0, '重复释放必须幂等');
});

test('旧代次的保存确认被拒绝，不改变状态', () => {
  const lease = newLease();
  lease.generation = 2;
  requestPause(lease, { reason: 'close' });
  const stale = completePause(lease, { generation: 1, revision: 3 });
  assert.equal(stale.kind, 'refused');
  assert.equal(lease.state, 'pausing');
  assert.equal(lease.lastRevision, null);
});

test('暂停超时：不再等游戏，回落到最近检查点并如实说明恢复位置', () => {
  const lease = newLease();
  lease.lastRevision = 4;
  requestPause(lease, { reason: 'close' });
  const outcome = abandonPause(lease, 'timeout');
  assert.equal(outcome.kind, 'timeout');
  assert.equal(outcome.revision, 4);
  assert.match(outcome.message, new RegExp(`${String(PAUSE_TIMEOUT_MS)}ms`));
  assert.match(outcome.message, /r4/);
  assert.equal(lease.state, 'recovery-available');
});

test('暂停后 Bridge 拒绝新请求，旧代次返回 STALE_RUNTIME', () => {
  const lease = newLease();
  const ok = admitBridgeCall(lease, { generation: lease.generation, method: 'ai.generate' }, BRIDGE_METHODS);
  assert.equal(ok.allowed, true);

  const stale = admitBridgeCall(lease, { generation: lease.generation - 1, method: 'ai.generate' }, BRIDGE_METHODS);
  assert.deepEqual(stale, { allowed: false, code: 'STALE_RUNTIME', message: stale.message });

  const notAllowed = admitBridgeCall(lease, { generation: lease.generation, method: 'dsh.rpc' }, BRIDGE_METHODS);
  assert.equal(notAllowed.allowed, false);
  assert.equal(/** @type {any} */ (notAllowed).code, 'PROTOCOL_INVALID');

  requestPause(lease, { reason: 'close' });
  const paused = admitBridgeCall(lease, { generation: lease.generation, method: 'ai.generate' }, BRIDGE_METHODS);
  assert.equal(paused.allowed, false);
  assert.equal(/** @type {any} */ (paused).code, 'PAUSED');
});

test('销毁后不再持有任何引用（运行时引用可被回收）', () => {
  const lease = newLease();
  lease.inflight.add('req-1');
  destroyRuntime(lease);
  assert.equal(lease.state, 'destroyed');
  assert.equal(lease.portBound, false);
  assert.equal(lease.nonce, '', '销毁必须清掉一次性 nonce');
  assert.equal(lease.inflight.size, 0);
});
