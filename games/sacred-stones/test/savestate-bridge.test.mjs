import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSavestateBridge, SNAPSHOT_SCHEMA} from '../src/save/savestate-bridge.js';

function fakeKernel() {
  let state = {ram: new Uint8Array([1, 2, 3]), frame: 10};
  let restored = 0;
  return {
    get state() {
      return state;
    },
    get restoredCount() {
      return restored;
    },
    set state(next) {
      state = next;
    },
    snapshot() {
      return structuredClone(state);
    },
    restore(snap) {
      restored += 1;
      state = structuredClone(snap);
    },
  };
}

test('snapshot：包成 {schema, gameVersion, payload}，payload 是独立副本', () => {
  const kernel = fakeKernel();
  const bridge = createSavestateBridge({kernel, gameVersion: () => '1.2.3'});
  const snap = bridge.snapshot();
  assert.equal(snap.schema, SNAPSHOT_SCHEMA);
  assert.equal(snap.gameVersion, '1.2.3');
  assert.ok(snap.payload.ram instanceof Uint8Array);
  snap.payload.ram[0] = 99;
  assert.equal(kernel.state.ram[0], 1, '改快照不能带坏内核状态');
});

test('restore：正常回滚', () => {
  const kernel = fakeKernel();
  const bridge = createSavestateBridge({kernel});
  const snap = bridge.snapshot();
  kernel.state = {ram: new Uint8Array([9, 9, 9]), frame: 99};
  assert.deepEqual(bridge.restore(snap), {ok: true});
  assert.equal(kernel.state.frame, 10);
  assert.deepEqual([...kernel.state.ram], [1, 2, 3]);
});

test('restore：schema 不符返回明确原因，不抛', () => {
  const bridge = createSavestateBridge({kernel: fakeKernel()});
  const result = bridge.restore({schema: 99, payload: {}});
  assert.equal(result.ok, false);
  assert.match(result.reason, /schema/);
});

test('restore：内核拒绝时把原因带出来，不吞异常', () => {
  const bridge = createSavestateBridge({
    kernel: {
      snapshot: () => ({}),
      restore: () => {
        throw new Error('bad state');
      },
    },
  });
  const result = bridge.restore({schema: SNAPSHOT_SCHEMA, payload: {}});
  assert.equal(result.ok, false);
  assert.match(result.reason, /bad state/);
});

test('meta：带版本 + 上报的章节信息', () => {
  const bridge = createSavestateBridge({
    kernel: fakeKernel(),
    gameVersion: () => '0.1.0',
    readMeta: () => ({chapter: 3, turn: 5}),
  });
  assert.deepEqual(bridge.meta(), {gameVersion: '0.1.0', chapter: 3, turn: 5});
});
