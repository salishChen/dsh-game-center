/**
 * 存档摘要（不是加密，只用来发现截断/损坏/内容漂移）
 *
 * 为什么不用 JSON.stringify：
 * 存档是「纯对象 + TypedArray」（内核 savestate 就是这形状），
 * JSON 会把 Uint8Array 展开成 {"0":0,"1":...}，几十万键，既慢又大，
 * 而且键序依赖插入顺序，同一个状态可能算出两种摘要。
 *
 * 这里按固定规则遍历：
 * - TypedArray / ArrayBuffer → 直接吃字节
 * - string → UTF-8 字节
 * - number → 8 字节 float64（保留 NaN/±0 区别之外的常规值）
 * - boolean / null / undefined → 单字节标记
 * - Array → 顺序
 * - 对象 → 键**排序后**遍历（键序不影响摘要）
 */

const f64 = typeof Float64Array === 'function' ? new Float64Array(1) : null;
const f64Bytes = f64 ? new Uint8Array(f64.buffer) : null;
const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

const TAG = {null: 0, undefined: 1, true: 2, false: 3, number: 4, string: 5, array: 6, object: 7, bytes: 8};

/** 两个 32 位累加器，互相错开，比单个 FNV 更不容易撞。 */
function makeState() {
  return {h1: 0x9e3779b9, h2: 0x85ebca6b};
}

function mixByte(state, byte) {
  state.h1 = Math.imul(state.h1 ^ byte, 0x01000193) >>> 0;
  state.h2 = Math.imul(state.h2 + byte + 0x9e3779b9, 0x27d4eb2d) >>> 0;
}

function mixTag(state, tag) {
  mixByte(state, tag);
}

function mixBytes(state, bytes) {
  for (let i = 0; i < bytes.length; i += 1) mixByte(state, bytes[i]);
}

function mixLength(state, length) {
  // 长度参与摘要，避免 "ab"+"c" 与 "a"+"bc" 同结果
  mixByte(state, length & 0xff);
  mixByte(state, (length >>> 8) & 0xff);
  mixByte(state, (length >>> 16) & 0xff);
  mixByte(state, (length >>> 24) & 0xff);
}

function walk(state, value, depth) {
  if (depth > 64) throw new RangeError('digestOf: 结构嵌套过深（>64）');
  if (value === null) return mixTag(state, TAG.null);
  if (value === undefined) return mixTag(state, TAG.undefined);

  const type = typeof value;
  if (type === 'boolean') return mixTag(state, value ? TAG.true : TAG.false);
  if (type === 'number') {
    mixTag(state, TAG.number);
    if (f64) {
      const v = Number.isNaN(value) ? NaN : value;
      f64[0] = v;
      mixBytes(state, f64Bytes);
    } else {
      const text = String(value);
      mixLength(state, text.length);
      for (let i = 0; i < text.length; i += 1) mixByte(state, text.charCodeAt(i) & 0xff);
    }
    return undefined;
  }
  if (type === 'string') {
    mixTag(state, TAG.string);
    const bytes = encoder ? encoder.encode(value) : null;
    if (bytes) {
      mixLength(state, bytes.length);
      mixBytes(state, bytes);
    } else {
      mixLength(state, value.length);
      for (let i = 0; i < value.length; i += 1) mixByte(state, value.charCodeAt(i) & 0xff);
    }
    return undefined;
  }
  if (type === 'bigint') {
    mixTag(state, TAG.number);
    return walk(state, Number(value), depth + 1);
  }
  if (type === 'function') return mixTag(state, TAG.undefined);

  if (ArrayBuffer.isView(value)) {
    mixTag(state, TAG.bytes);
    const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    mixLength(state, view.length);
    mixBytes(state, view);
    return undefined;
  }
  if (value instanceof ArrayBuffer) {
    mixTag(state, TAG.bytes);
    mixLength(state, value.byteLength);
    mixBytes(state, new Uint8Array(value));
    return undefined;
  }
  if (Array.isArray(value)) {
    mixTag(state, TAG.array);
    mixLength(state, value.length);
    for (let i = 0; i < value.length; i += 1) walk(state, value[i], depth + 1);
    return undefined;
  }

  mixTag(state, TAG.object);
  const keys = Object.keys(value).sort();
  mixLength(state, keys.length);
  for (const key of keys) {
    mixLength(state, key.length);
    for (let i = 0; i < key.length; i += 1) mixByte(state, key.charCodeAt(i) & 0xff);
    walk(state, value[key], depth + 1);
  }
  return undefined;
}

/** 稳定摘要，形如 `c1:xxxxxxxxxxxxxxxx`。 */
export function digestOf(value) {
  const state = makeState();
  walk(state, value, 0);
  return `c1:${state.h1.toString(16).padStart(8, '0')}${state.h2.toString(16).padStart(8, '0')}`;
}

/** 递归统计原始字节数（TypedArray 按真实字节，不是 JSON 文本长度）。 */
export function sizeOf(value, depth = 0) {
  if (depth > 64) throw new RangeError('sizeOf: 结构嵌套过深（>64）');
  if (value === null || value === undefined) return 0;
  const type = typeof value;
  if (type === 'string') {
    return encoder ? encoder.encode(value).length : value.length;
  }
  if (type === 'number') return 8;
  if (type === 'boolean') return 1;
  if (type === 'bigint') return 8;
  if (type === 'function') return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + sizeOf(item, depth + 1), 0);
  let sum = 0;
  for (const key of Object.keys(value)) sum += key.length + sizeOf(value[key], depth + 1);
  return sum;
}
