/**
 * 卡带缓存：把用户选过的 ROM 存在本机 IndexedDB，下次不用重选
 *
 * 为什么需要：ROM 不进仓库、也不该被上传，所以每次打开页面都得让玩家重新选一个 16 MB 的文件。
 * 存一份在本机 IndexedDB 是最省事的折中：不用重选，也仍然没有离开这台机器。
 *
 * 边界：
 * - 只写本机 IndexedDB，不上传（这个页面的网络请求本来就只有加载自身脚本）
 * - 玩家可以随时「忘掉这个卡带」，删的是我们自己的库，不碰文件
 * - 缓存的是原样字节，不做任何转换，避免"我存的和你选的不是同一份"
 */

const DB_NAME = 'sacred-stones-rom';
const DB_VERSION = 1;
const STORE = 'rom';
const KEY = 'current';

function openDb(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打不开卡带缓存'));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('卡带缓存请求失败'));
  });
}

/**
 * @param {object} options
 * @param {object} options.indexedDB 浏览器里传 globalThis.indexedDB
 */
export function createRomCache(options) {
  const idb = options?.indexedDB;
  if (!idb || typeof idb.open !== 'function') throw new TypeError('createRomCache 需要 indexedDB');

  async function withStore(mode, run) {
    const db = await openDb(idb);
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      return await run(store, tx);
    } finally {
      db.close();
    }
  }

  return {
    /** @param {Uint8Array} bytes */
    save(bytes) {
      return withStore('readwrite', async (store, tx) => {
        const request = store.put({bytes, savedAt: Date.now()}, KEY);
        const done = requestToPromise(request);
        await done;
        return new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve({bytes: bytes.length});
          tx.onerror = () => reject(tx.error ?? new Error('写卡带缓存失败'));
        });
      });
    },

    /** @returns {Promise<{bytes: Uint8Array, savedAt: number} | null>} */
    async load() {
      const record = await withStore('readonly', (store) => requestToPromise(store.get(KEY)));
      if (!record?.bytes) return null;
      return {bytes: new Uint8Array(record.bytes), savedAt: record.savedAt ?? 0};
    },

    clear() {
      return withStore('readwrite', (store) => requestToPromise(store.delete(KEY)));
    },
  };
}
