import test from 'node:test';
import assert from 'node:assert/strict';
import {createGameSession} from '../src/save/game-session.js';

/** 内存存档池存储：只做存取，不含策略（策略在 save-pool 里）。 */
function createMemoryStore() {
  const rows = new Map();
  return {
    rows,
    async list() {
      return [...rows.values()].map((r) => r.meta);
    },
    async read(slot) {
      const row = rows.get(slot);
      return row ? {meta: structuredClone(row.meta), payload: structuredClone(row.payload)} : null;
    },
    async write(slot, rec) {
      rows.set(slot, {meta: structuredClone(rec.meta), payload: structuredClone(rec.payload)});
    },
    async remove(slot) {
      rows.delete(slot);
    },
  };
}

/** 可控内核：状态就是 {turn}，便于断言读档真的回滚了。 */
function createFakeKernel() {
  const state = {turn: 0, ram: new Uint8Array([0, 0, 0, 0])};
  return {
    state,
    bridge: {
      snapshot: () => ({schema: 1, gameVersion: '0.1.0', payload: structuredClone(state)}),
      restore: (snapshot) => {
        Object.assign(state, structuredClone(snapshot.payload));
        return {ok: true};
      },
    },
  };
}

function fakeTimers() {
  const callbacks = new Map();
  let nextId = 1;
  return {
    fire() {
      for (const fn of callbacks.values()) fn();
    },
    setInterval(fn) {
      const id = nextId++;
      callbacks.set(id, fn);
      return id;
    },
    clearInterval(id) {
      callbacks.delete(id);
    },
    size() {
      return callbacks.size;
    },
  };
}

function harness() {
  const kernel = createFakeKernel();
  const store = createMemoryStore();
  const timers = fakeTimers();
  let clock = 1_000_000;
  const session = createGameSession({
    bridge: kernel.bridge,
    store,
    gameVersion: () => '0.1.0',
    now: () => (clock += 1000),
    timers,
  });
  return {kernel, store, timers, session};
}

test('手动存档：进手动池，可读回，内核状态被回滚', async () => {
  const {kernel, session} = harness();
  kernel.state.turn = 7;
  const {meta} = await session.saveManual('第 3 章前');
  assert.equal(meta.pool, 'manual');
  assert.equal(meta.name, '第 3 章前');

  kernel.state.turn = 99;
  const loaded = await session.load(meta.slot);
  assert.equal(loaded.ok, true);
  assert.equal(kernel.state.turn, 7);
});

test('自动存档：定时器到点存进自动池，reason=auto', async () => {
  const {kernel, session, timers} = harness();
  session.start();
  kernel.state.turn = 3;
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));

  const autos = await session.pool.listPool('auto');
  assert.equal(autos.length, 1);
  assert.equal(autos[0].reason, 'auto');
  assert.deepEqual(await session.autoUsage(), {used: 1, limit: 20});
});

test('关闭游戏：先存一份 reason=close 进自动池，并停掉定时器', async () => {
  const {kernel, session, timers} = harness();
  session.start();
  kernel.state.turn = 12;

  const result = await session.close();
  assert.equal(result.reason, 'close');
  assert.equal(timers.size(), 0);

  const autos = await session.pool.listPool('auto');
  assert.equal(autos.length, 1);
  assert.equal(autos[0].reason, 'close');
});

test('自动池 20 份上限：第 21 份淘汰最旧的那份自动存档，手动档不受影响', async () => {
  const {kernel, session} = harness();
  await session.saveManual('保命的档');
  for (let i = 0; i < 21; i += 1) {
    kernel.state.turn = i;
    await session.pool.save({payload: kernel.bridge.snapshot(), reason: 'auto'});
  }
  const autos = await session.pool.listPool('auto');
  assert.equal(autos.length, 20);
  assert.equal((await session.pool.listPool('manual')).length, 1);
});

test('坏档不覆盖好档：checksum 对不上时报 CORRUPT，且手动档仍在', async () => {
  const {kernel, session, store} = harness();
  const {meta} = await session.saveManual('原始档');
  const row = store.rows.get(meta.slot);
  row.payload.payload.turn = 1234; // 改了内容但没更新 checksum

  const result = await session.load(meta.slot);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CORRUPT');
  assert.equal((await session.pool.listPool('manual')).length, 1);
});

test('版本不兼容显式报错，不静默失败', async () => {
  const {kernel, session, store} = harness();
  const {meta} = await session.saveManual('老版本档');
  store.rows.get(meta.slot).meta.gameVersion = '0.0.9';

  const result = await session.load(meta.slot);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERSION_MISMATCH');
  assert.match(result.message, /0\.0\.9/);
});

test('内核拒收快照时返回 KERNEL_REJECTED，而不是假装成功', async () => {
  const kernel = createFakeKernel();
  kernel.bridge.restore = () => ({ok: false, reason: '内核版本不认识这个快照'});
  const session = createGameSession({
    bridge: kernel.bridge,
    store: createMemoryStore(),
    gameVersion: () => '0.1.0',
  });
  const {meta} = await session.saveManual('x');
  const result = await session.load(meta.slot);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'KERNEL_REJECTED');
  assert.match(result.message, /不认识/);
});

test('读不存在的档返回 NOT_FOUND', async () => {
  const {session} = harness();
  const result = await session.load('nope');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NOT_FOUND');
});
