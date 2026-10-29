/**
 * 内存读写封装（A 路线）
 *
 * 目的：把"按名字读/写"这一层从内核里隔开。
 * - 游戏代码只说 `mem.u16('cursorTileX')`，不出现魔法数字；
 * - 地址只在地址表里出现一次，改地址改一处；
 * - 内核（gba-kit / mGBA / 以后换的）只提供 `{read8,read16,read32,write8,write16}` 五个原始方法。
 *
 * 设计约束（都是踩过的坑）：
 * - **写入只允许 u8/u16**：GBA 上 32 位写会被硬件拆成两次 16 位，语义不同，不给它开口子。
 * - 读不到（地址越界、内核抛错）一律返回 `null`，**不返回 0**：0 是合法值，用它当"读失败"会让 bug 静默。
 */

import {parseAddressTable, assertRomMatches} from './address-table.js';

/**
 * @param {object} options
 * @param {object} options.table 原始地址表（JSON）
 * @param {string} options.romId 当前加载 ROM 的标识（如 sha256:...）
 * @param {{read8:Function, read16:Function, read32:Function, write8:Function, write16:Function}} options.io
 * @param {boolean} [options.allowMismatch] 仅逆向实验用
 */
export function createMemoryAccess(options) {
  const table = options?.table?.entries instanceof Map ? options.table : parseAddressTable(options.table);
  const io = options.io;
  if (!io || typeof io.read16 !== 'function') {
    throw new TypeError('createMemoryAccess 需要 io（read8/read16/read32/write8/write16）');
  }
  assertRomMatches(table, options.romId, {allowMismatch: options.allowMismatch});

  function entryOf(name) {
    const entry = table.entries.get(name);
    if (!entry) throw new Error(`地址表里没有 ${name}（可用的项：${[...table.entries.keys()].join(', ')}）`);
    return entry;
  }

  function safeRead(fn, address) {
    try {
      const value = fn.call(io, address);
      return Number.isInteger(value) ? value : null;
    } catch {
      return null;
    }
  }

  return {
    table,

    /** 地址本身，供日志/调试用；业务代码应优先用按名读写。 */
    addressOf(name) {
      return entryOf(name).address;
    },

    has(name) {
      return table.entries.has(name);
    },

    names() {
      return [...table.entries.keys()];
    },

    /** 按表声明的宽度读；读失败返回 null（不是 0）。 */
    read(name) {
      const entry = entryOf(name);
      const fn = entry.width === 1 ? io.read8 : entry.width === 2 ? io.read16 : io.read32;
      return safeRead(fn, entry.address);
    },

    readU8(name) {
      return safeRead(io.read8, entryOf(name).address);
    },

    readU16(name) {
      return safeRead(io.read16, entryOf(name).address);
    },

    readU32(name) {
      return safeRead(io.read32, entryOf(name).address);
    },

    /** 只允许 u8/u16 写；32 位写在 GBA 上是两次 16 位写，语义不同，故意不提供。 */
    writeU8(name, value) {
      const entry = entryOf(name);
      if (entry.width !== 1) throw new Error(`${name} 声明为 ${entry.width} 字节，不能用 writeU8 写`);
      io.write8(entry.address, value & 0xff);
    },

    writeU16(name, value) {
      const entry = entryOf(name);
      if (entry.width === 1) throw new Error(`${name} 声明为 1 字节，不能用 writeU16 写`);
      io.write16(entry.address, value & 0xffff);
    },

    /** 绝对地址读写：只在逆向脚本、调试面板里用，业务代码别碰。 */
    raw: {
      read8: (address) => safeRead(io.read8, address),
      read16: (address) => safeRead(io.read16, address),
      read32: (address) => safeRead(io.read32, address),
      write16: (address, value) => io.write16(address, value & 0xffff),
    },
  };
}
