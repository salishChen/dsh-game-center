/**
 * 内存地址表：A 路线唯一的硬伤来源
 *
 * 为什么单独成文件、还要带版本校验：
 * 地址表错了，鼠标点到的地方和读到的状态全是错的，而且**不会报错**——只会表现得"怪"。
 * 所以每条表都必须绑定它被测出来的那份 ROM（`romId`），加载时对不上就拒绝使用。
 *
 * 表结构（JSON 友好，可入库）：
 * {
 *   "schema": 1,
 *   "romId": "sha256:167ed579...",       // 这份地址是在哪份 ROM 上实测的
 *   "gameVersion": "0.1.0",              // 表对应的游戏逻辑版本
 *   "entries": {
 *     "cursorTileX": { "address": "0x0202BCC4", "type": "u16", "note": "光标格 X" }
 *   }
 * }
 */

export const ADDRESS_TABLE_SCHEMA = 1;

const TYPE_WIDTH = Object.freeze({u8: 1, u16: 2, u32: 4});

function parseAddress(raw, name) {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError(`地址表项 ${name} 的地址不合法：${String(raw)}`);
  }
  return value;
}

/**
 * 校验并规范化地址表。任何结构问题都在这里炸，不要留到运行时才发现。
 * @returns {{schema:number, romId:string, gameVersion:string|null, entries:Map<string,{address:number,type:string,width:number,note:string|null}>}}
 */
export function parseAddressTable(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('地址表必须是对象');
  if (raw.schema !== ADDRESS_TABLE_SCHEMA) {
    throw new TypeError(`地址表 schema 不匹配：需要 ${ADDRESS_TABLE_SCHEMA}，实际 ${String(raw.schema)}`);
  }
  if (typeof raw.romId !== 'string' || raw.romId.length === 0) {
    throw new TypeError('地址表缺少 romId（这份地址是在哪份 ROM 上实测的）');
  }
  const rawEntries = raw.entries;
  if (!rawEntries || typeof rawEntries !== 'object') throw new TypeError('地址表缺少 entries');

  const entries = new Map();
  for (const [name, entry] of Object.entries(rawEntries)) {
    if (!entry || typeof entry !== 'object') throw new TypeError(`地址表项 ${name} 必须是对象`);
    const type = entry.type ?? 'u16';
    if (!TYPE_WIDTH[type]) throw new TypeError(`地址表项 ${name} 的 type 不支持：${type}`);
    const width = TYPE_WIDTH[type];
    const address = parseAddress(entry.address, name);
    if (width > 1 && address % width !== 0) {
      throw new RangeError(`地址表项 ${name} 地址 0x${address.toString(16)} 未按 ${width} 字节对齐`);
    }
    entries.set(name, {address, type, width, note: entry.note ?? null});
  }
  if (entries.size === 0) throw new TypeError('地址表 entries 为空');

  return {
    schema: raw.schema,
    romId: raw.romId,
    gameVersion: raw.gameVersion ?? null,
    entries,
  };
}

/**
 * 版本闸门：表里记录的 romId 必须与当前加载的 ROM 一致，否则拒绝。
 * 允许调用方显式跳过（只在做逆向实验时），但必须传 `allowMismatch: true` 才放行。
 */
export function assertRomMatches(table, currentRomId, options = {}) {
  if (options.allowMismatch === true) return;
  if (!currentRomId) {
    throw new Error('加载地址表必须提供当前 ROM 的 romId，用来核对地址是在哪份 ROM 上测的');
  }
  if (table.romId !== currentRomId) {
    throw new Error(
      `地址表与 ROM 不匹配：表来自 ${table.romId}，当前 ROM 是 ${currentRomId}。` +
        '地址必须重新实测，不能套用另一份 ROM 的表。',
    );
  }
}
