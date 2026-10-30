import test from 'node:test';
import assert from 'node:assert/strict';
import {createIdbStore} from '../src/save/idb-store.js';
import {createSavePool} from '../src/save/save-pool.js';

/**
 * 最小假 IndexedDB：只实现被测到的 API（open/onupgradeneeded/transaction/
 * objectStore/put/get/getAll/delete + oncomplete/onerror/onabort）。
 * 故意的：不实现游标、索引、版本迁移之外的东西，免得测试替身比实现还复杂。
 */
function createFakeIndexedDB({failOn = null, abortOn = null} = {}) {
  const databases = new Map();
  let openCount = 0;

  function makeRequest(runner) {
    const request = {result: undefined, error: null, onsuccess: null, onerror: null};
    queueMicrotask(() => {
      try {
        request.result = runner();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    });
    return request;
  }

  class FakeObjectStore {
    constructor(rows, name) {
      this.rows = rows;
      this.name = name;
    }
    put(value) {
      return makeRequest(() => {
        if (failOn === `${this.name}:put`) throw new Error('QuotaExceededError');
        this.rows.set(value.slot, structuredClone(value));
        return value.slot;
      });
    }
    get(key) {
      return makeRequest(() => (this.rows.has(key) ? structuredClone(this.rows.get(key)) : undefined));
    }
    getAll() {
      return makeRequest(() => [...this.rows.values()].map((v) => structuredClone(v)));
    }
    delete(key) {
      return makeRequest(() => {
        this.rows.delete(key);
        return undefined;
      });
    }
  }

  class FakeTransaction {
    constructor(db, storeNames, mode) {
      this.db = db;
      this.mode = mode;
      this.stores = storeNames.map((n) => new FakeObjectStore(db.tables.get(n), n));
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.aborted = false;
      // 真 IDB 要等所有请求都结束后事务才 complete；用宏任务模拟这个"等请求落定"
      this.timer = setTimeout(() => {
        if (abortOn === 'transaction') {
          this.aborted = true;
          this.onabort?.();
        } else if (!this.aborted) {
          this.oncomplete?.();
        }
      }, 0);
    }
    objectStore(name) {
      const store = this.stores.find((s) => s.name === name);
      if (!store) throw new Error(`no object store ${name}`);
      return store;
    }
    abort() {
      if (this.aborted) return;
      this.aborted = true;
      clearTimeout(this.timer);
      this.onabort?.();
    }
  }

  class FakeDb {
    constructor(name) {
      this.name = name;
      this.tables = new Map();
      this.objectStoreNames = {
        contains: (n) => this.tables.has(n),
      };
    }
    createObjectStore(name) {
      this.tables.set(name, new Map());
      return {name};
    }
    transaction(storeNames, mode) {
      return new FakeTransaction(this, storeNames, mode);
    }
  }

  return {
    get openCount() {
      return openCount;
    },
    open(name, version) {
      openCount += 1;
      const request = {result: null, onsuccess: null, onerror: null, onupgradeneeded: null};
      queueMicrotask(() => {
        let db = databases.get(name);
        if (!db) {
          db = new FakeDb(name);
          databases.set(name, db);
          request.result = db;
          request.onupgradeneeded?.();
        } else {
          request.result = db;
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function harness(opts) {
  const indexedDB = createFakeIndexedDB(opts);
  const store = createIdbStore({indexedDB, dbName: 'test-db'});
  return {indexedDB, store};
}

test('写入后能读回 meta 与 payload，TypedArray 保真', async () => {
  const {store} = harness();
  const payload = {schema: 1, payload: {ram: new Uint8Array([1, 2, 3])}};
  await store.write('s1', {meta: {slot: 's1', bytes: 3}, payload});
  const rec = await store.read('s1');
  assert.equal(rec.meta.slot, 's1');
  assert.ok(rec.payload.payload.ram instanceof Uint8Array);
  assert.deepEqual([...rec.payload.payload.ram], [1, 2, 3]);
});

test('list 只返回 meta，不碰 payload', async () => {
  const {store} = harness();
  await store.write('a', {meta: {slot: 'a', pool: 'manual'}, payload: {big: new Uint8Array(1000)}});
  await store.write('b', {meta: {slot: 'b', pool: 'auto'}, payload: {big: new Uint8Array(1000)}});
  const rows = await store.list();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !('payload' in r)));
  assert.deepEqual(rows.map((r) => r.slot).sort(), ['a', 'b']);
});

test('remove 之后 read 返回 null', async () => {
  const {store} = harness();
  await store.write('x', {meta: {slot: 'x'}, payload: {}});
  await store.remove('x');
  assert.equal(await store.read('x'), null);
});

test('不存在的档 read 返回 null（不是抛异常）', async () => {
  const {store} = harness();
  assert.equal(await store.read('nope'), null);
});

test('打开只发生一次（多次调用复用连接）', async () => {
  const {indexedDB, store} = harness();
  await store.list();
  await store.list();
  assert.equal(indexedDB.openCount, 1);
});

test('写失败时整个事务失败，meta 与 payload 都不会半写', async () => {
  const {store} = harness({failOn: 'data:put'});
  await assert.rejects(() => store.write('z', {meta: {slot: 'z'}, payload: {}}));
  assert.equal(await store.read('z'), null);
});

test('事务被中止时 write 抛错，不静默成功', async () => {
  const {store} = harness({abortOn: 'transaction'});
  await assert.rejects(() => store.write('q', {meta: {slot: 'q'}, payload: {}}), /中止|abort/i);
});

test('与存档池联调：写入→列表→按池过滤→删除', async () => {
  const {store} = harness();
  const pool = createSavePool({store, gameVersion: () => '0.1.0'});
  await pool.save({payload: {n: 1}, reason: 'manual', slot: 'm1'});
  await pool.save({payload: {n: 2}, reason: 'auto', slot: 'a1'});

  assert.equal((await pool.listPool('manual')).length, 1);
  assert.equal((await pool.listPool('auto')).length, 1);
  assert.deepEqual(await pool.autoUsage(), {used: 1, limit: 20});

  const loaded = await pool.load('m1');
  assert.equal(loaded.ok, true);
  await pool.remove('m1');
  assert.equal((await pool.listAll()).length, 1);
});
