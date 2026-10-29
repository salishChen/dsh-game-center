import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoSaver} from '../src/save/auto-saver.js';

/** 可控定时器：把 setInterval 的回调抓在手里，由测试决定什么时候触发。 */
function fakeTimers() {
  const handles = new Map();
  let nextId = 1;
  return {
    fire(id) {
      const handle = handles.get(id);
      assert.ok(handle, `没有 id=${id} 的定时器`);
      handle();
    },
    count() {
      return handles.size;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      handles.set(id, fn);
      handles.set(`${id}:ms`, ms);
      return id;
    },
    clearInterval(id) {
      handles.delete(id);
      handles.delete(`${id}:ms`);
    },
    intervalOf(id) {
      return handles.get(`${id}:ms`);
    },
  };
}

function harness(overrides = {}) {
  const timers = fakeTimers();
  const saved = [];
  let clock = 1000;
  const saver = createAutoSaver({
    capture: () => ({frame: saved.length}),
    save: async (payload, reason) => {
      saved.push({payload, reason, at: clock});
      return {ok: true};
    },
    now: () => (clock += 1),
    timers,
    ...overrides,
  });
  return {saver, timers, saved};
}

test('默认每 5 分钟自动存一次', () => {
  const {saver, timers} = harness();
  const {started} = saver.start();
  assert.equal(started, true);
  assert.equal(timers.intervalOf(1), 5 * 60 * 1000);
  saver.stop();
});

test('start 幂等：重复 start 不会挂两个定时器', () => {
  const {saver, timers} = harness();
  saver.start();
  const second = saver.start();
  assert.equal(second.started, false);
  assert.equal(second.code, 'ALREADY_RUNNING');
  assert.equal(timers.count(), 2); // 一个回调 + 一个 ms 标记
  saver.stop();
});

test('stop 之后定时器被清掉，不再写存档', async () => {
  const {saver, timers, saved} = harness();
  saver.start();
  saver.stop();
  assert.equal(timers.count(), 0);
  const r = await saver.tick('auto');
  assert.equal(r.reason, 'auto');
  assert.equal(saved.length, 1, 'tick 是手动调用，不受 stop 影响');
});

test('定时器到点会自动存，reason 是 auto', async () => {
  const {saver, timers, saved} = harness();
  saver.start();
  timers.fire(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].reason, 'auto');
  saver.stop();
});

test('不许并发：上一次没写完，第二次直接跳过而不是排队', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const {saver} = harness({
    save: async () => {
      calls += 1;
      await gate;
    },
  });
  saver.start();
  const first = saver.tick('auto');
  await new Promise((resolve) => setImmediate(resolve));
  const second = await saver.tick('auto');
  assert.equal(first instanceof Promise, true);
  assert.deepEqual(second, {skipped: true, code: 'IN_FLIGHT'});
  release();
  await first;
  assert.equal(calls, 1);
  saver.stop();
});

test('关闭游戏：先存 reason=close 再停调度器', async () => {
  const {saver, timers, saved} = harness();
  saver.start();
  const result = await saver.shutdown();
  assert.equal(result.reason, 'close');
  assert.equal(saved[0].reason, 'close');
  assert.equal(saver.isRunning, false);
  assert.equal(timers.count(), 0);
});

test('写失败不停止调度器，错误交给 onError，也不留 inFlight 卡死', async () => {
  const errors = [];
  let attempt = 0;
  const {saver} = harness({
    save: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('quota exceeded');
      return {ok: true};
    },
    onError: (error) => errors.push(error),
  });
  const first = await saver.tick('auto');
  assert.ok(first.error instanceof Error);
  assert.equal(errors.length, 1);
  assert.equal(saver.stats.inFlight, false);

  const second = await saver.tick('auto');
  assert.equal(second.skipped, false);
  assert.equal(second.error, undefined);
  assert.equal(saver.stats.saveCount, 1);
});

test('stats 能看出上次存档时间与次数', async () => {
  const {saver} = harness();
  assert.equal(saver.stats.saveCount, 0);
  await saver.tick('manual');
  const stats = saver.stats;
  assert.equal(stats.saveCount, 1);
  assert.equal(typeof stats.lastSavedAt, 'number');
  assert.equal(stats.intervalMs, 300000);
});
