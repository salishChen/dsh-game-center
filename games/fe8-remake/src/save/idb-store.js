/**
 * IndexedDB 存储适配器（存档池的 store 实现）
 *
 * 为什么不用 localStorage：
 * - 一份 savestate 0.59 MiB，20 份自动档 ≈ 12 MB 原始 / 更别说 localStorage 全域 5 MB
 * - localStorage 同步阻塞主线程，写 12 MB 会直接卡帧
 *
 * 为什么 meta 与 data 分两个 objectStore：
 * 存档列表页只需要 meta（几十字节），不该把 20 份 590 KB 的 payload 全读进内存再丢掉。
 * 两个 store 在**同一个事务**里写，保证 meta 与 payload 不会一半一半。
 *
 * 事务语义：一次 write 里如果任何一步失败，整个事务 abort —— meta 写了但 data 没写的情况不会出现。
 */

const DB_NAME = 'dsh-game-saves';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_DATA = 'data';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

/**
 * @param {object} options
 * @param {object} options.indexedDB 注入的 IDB 实现（浏览器用 globalThis.indexedDB，测试用假实现）
 * @param {string} [options.dbName]
 */
export function createIdbStore(options) {
  const idb = options?.indexedDB;
  if (!idb || typeof idb.open !== 'function') {
    throw new TypeError('createIdbStore 需要 indexedDB（浏览器里是 globalThis.indexedDB）');
  }
  const dbName = options.dbName ?? DB_NAME;
  const name = options.name ?? 'fe8-remake';

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = idb.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const store of [STORE_META, STORE_DATA]) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, {keyPath: 'slot'});
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(`打开 ${dbName} 失败`));
    });
    return dbPromise;
  }

  /** 每个 slot 在自己库里是唯一的：`name` 允许同一套数据分游戏存放。 */
  function keyOf(slot) {
    return `${name}:${slot}`;
  }

  async function withStores(storeNames, mode, run) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error ?? new Error('事务失败'));
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(undefined);
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new Error('事务被中止'));
      Promise.resolve()
        .then(() => run(tx))
        .catch((error) => {
          // 请求级失败：显式中止事务，保证 meta 不会单独落盘
          try {
            tx.abort();
          } catch {
            /* 事务已结束就无所谓 */
          }
          fail(error);
        });
    });
  }

  return {
    /** 只读 meta，不碰 payload（列表页不该把 20 份 590 KB 读进内存）。 */
    async list() {
      const db = await openDb();
      const tx = db.transaction([STORE_META], 'readonly');
      const rows = await requestToPromise(tx.objectStore(STORE_META).getAll());
      return rows.map((row) => row.meta);
    },

    async read(slot) {
      const db = await openDb();
      const tx = db.transaction([STORE_META, STORE_DATA], 'readonly');
      const [metaRow, dataRow] = await Promise.all([
        requestToPromise(tx.objectStore(STORE_META).get(keyOf(slot))),
        requestToPromise(tx.objectStore(STORE_DATA).get(keyOf(slot))),
      ]);
      if (!metaRow || !dataRow) return null;
      return {meta: metaRow.meta, payload: dataRow.payload};
    },

    async write(slot, rec) {
      const key = keyOf(slot);
      await withStores([STORE_META, STORE_DATA], 'readwrite', async (tx) => {
        await requestToPromise(tx.objectStore(STORE_META).put({slot: key, meta: rec.meta}));
        await requestToPromise(tx.objectStore(STORE_DATA).put({slot: key, payload: rec.payload}));
      });
    },

    async remove(slot) {
      const key = keyOf(slot);
      await withStores([STORE_META, STORE_DATA], 'readwrite', async (tx) => {
        await requestToPromise(tx.objectStore(STORE_META).delete(key));
        await requestToPromise(tx.objectStore(STORE_DATA).delete(key));
      });
    },
  };
}
