import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_POOL_LIMIT,
  checksumOf,
  createSavePool,
  byteSizeOf as sizeOf,
} from '../src/save/save-pool.js';

/** 测试用内存存储：只做存取，不含任何策略。 */
function createMemoryStore() {
  const rows = new Map();
  return {
    rows,
    async list() {
      return [...rows.values()].map((r) => ({ ...r.meta }));
    },
    async read(slot) {
      const r = rows.get(slot);
      return r ? { meta: { ...r.meta }, payload: r.payload } : null;
    },
    async write(slot, rec) {
      rows.set(slot, { meta: { ...rec.meta }, payload: rec.payload });
    },
    async remove(slot) {
      rows.delete(slot);
    },
  };
}

function makePool(extra = {}) {
  let clock = 1_000;
  const store = createMemoryStore();
  const pool = createSavePool({
    store,
    now: () => (clock += 1_000),
    gameVersion: () => '1.0.0',
    ...extra,
  });
  return { pool, store };
}

test('手动存档无上限，自动存档默认上限 20', async () => {
  const { pool } = makePool();
  for (let i = 0; i < 35; i += 1) {
    await pool.save({ payload: { i }, reason: 'manual' });
  }
  assert.equal((await pool.listPool('manual')).length, 35);

  for (let i = 0; i < AUTO_POOL_LIMIT; i += 1) {
    await pool.save({ payload: { i }, reason: 'auto' });
  }
  const usage = await pool.autoUsage();
  assert.deepEqual(usage, { used: AUTO_POOL_LIMIT, limit: AUTO_POOL_LIMIT });
});

test('自动池满 20 后再存，淘汰最旧的一份，手动池不受影响', async () => {
  const { pool } = makePool();
  await pool.save({ payload: { keep: true }, reason: 'manual' });
  const slots = [];
  for (let i = 0; i < AUTO_POOL_LIMIT; i += 1) {
    const { meta } = await pool.save({ payload: { i }, reason: 'auto', slot: `auto-${i}` });
    slots.push(meta.slot);
  }

  const { evicted } = await pool.save({ payload: { i: 999 }, reason: 'auto', slot: 'auto-999' });

  assert.deepEqual(evicted, [slots[0]], '只淘汰最旧的那一份自动存档');
  const autos = await pool.listPool('auto');
  assert.equal(autos.length, AUTO_POOL_LIMIT);
  assert.ok(!autos.some((m) => m.slot === slots[0]), '最旧的已被删除');
  assert.ok(autos.some((m) => m.slot === 'auto-999'), '新存档在池内');

  const manuals = await pool.listPool('manual');
  assert.equal(manuals.length, 1, '淘汰只作用于自动池');
});

test('关闭游戏时的存档进自动池，reason 为 close', async () => {
  const { pool } = makePool();
  const { meta } = await pool.saveOnClose({ chapter: 1 });
  assert.equal(meta.pool, 'auto');
  assert.equal(meta.reason, 'close');
  assert.equal((await pool.listPool('manual')).length, 0);
});

test('关闭存档同样受 20 份上限约束（自动池是同一个池）', async () => {
  const { pool } = makePool();
  for (let i = 0; i < AUTO_POOL_LIMIT; i += 1) {
    await pool.save({ payload: { i }, reason: 'auto' });
  }
  const { evicted } = await pool.saveOnClose({ closing: true });
  assert.equal(evicted.length, 1, '关闭存档也要挤掉最旧的一份');
  assert.equal((await pool.listPool('auto')).length, AUTO_POOL_LIMIT);
});

test('并发写被串行化：同一时刻只有一个写事务，索引不会写坏', async () => {
  const store = createMemoryStore();
  let active = 0;
  let maxActive = 0;
  const slowStore = {
    ...store,
    async write(slot, rec) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      await store.write(slot, rec);
      active -= 1;
    },
  };
  let clock = 0;
  const pool = createSavePool({
    store: slowStore,
    now: () => (clock += 1),
    gameVersion: () => '1.0.0',
  });

  const jobs = [];
  for (let i = 0; i < 8; i += 1) {
    jobs.push(pool.save({ payload: { i }, reason: i % 2 ? 'manual' : 'auto', slot: `s-${i}` }));
  }
  jobs.push(pool.saveOnClose({ closing: true }));
  await Promise.all(jobs);

  assert.equal(maxActive, 1, '写事务必须串行，不能并发');
  assert.equal((await pool.listAll()).length, 9);
});

test('读档校验 checksum，坏档返回 CORRUPT 且不影响其它存档', async () => {
  const { pool, store } = makePool();
  const { meta } = await pool.save({ payload: { hp: 20 }, reason: 'manual', slot: 'm1' });
  await pool.save({ payload: { hp: 30 }, reason: 'manual', slot: 'm2' });

  const rec = store.rows.get('m1');
  store.rows.set('m1', { meta: { ...rec.meta, checksum: 'c1:00000000deadbeef' }, payload: rec.payload });

  const bad = await pool.load('m1');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'CORRUPT');

  const good = await pool.load('m2');
  assert.equal(good.ok, true);
  assert.deepEqual(good.payload, { hp: 30 });
  assert.equal(good.meta.checksum, checksumOf({ hp: 30 }));
  assert.ok(meta.checksum.startsWith('c1:'));
});

test('版本不兼容显式报错，不静默失败', async () => {
  const { pool } = makePool();
  await pool.save({ payload: { a: 1 }, reason: 'manual', slot: 'old' });

  const newer = createSavePool({
    store: (await (async () => {
      const s = createMemoryStore();
      const p = createSavePool({ store: s, now: () => 1, gameVersion: () => '0.3.9' });
      await p.save({ payload: { a: 1 }, reason: 'manual', slot: 'old' });
      return s;
    })()),
    now: () => 2,
    gameVersion: () => '1.0.0',
  });

  const result = await newer.load('old');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'VERSION_MISMATCH');
  assert.match(result.message, /0\.3\.9/);
  assert.match(result.message, /1\.0\.0/);
});

test('读不存在的槽位返回 NOT_FOUND', async () => {
  const { pool } = makePool();
  const r = await pool.load('nope');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NOT_FOUND');
});

test('存档元信息带齐 slot/pool/reason/createdAt/gameVersion/bytes/checksum', async () => {
  const { pool } = makePool();
  const { meta } = await pool.save({ payload: { abc: 1 }, reason: 'manual', slot: 'x' });
  assert.equal(meta.slot, 'x');
  assert.equal(meta.pool, 'manual');
  assert.equal(meta.reason, 'manual');
  assert.equal(meta.gameVersion, '1.0.0');
  assert.equal(typeof meta.createdAt, 'number');
  // bytes 现在是「原始字节数」（键 + 值），不是 JSON 文本长度：
  // 存档是纯对象 + TypedArray，JSON 长度既不准也不慢得离谱得离谱
  assert.equal(meta.bytes, sizeOf({abc: 1}));
  assert.equal(meta.bytes, 'abc'.length + 8);
  assert.equal(meta.checksum, checksumOf({abc: 1}));
});
