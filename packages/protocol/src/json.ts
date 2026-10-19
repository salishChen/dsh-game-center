/**
 * JSON 值类型：存档与 Bridge 载荷只允许可 JSON 化数据。
 * 禁止函数、Date、Map、Promise 等宿主对象进入快照。
 */
export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type JsonObject = { [key: string]: JsonValue }
