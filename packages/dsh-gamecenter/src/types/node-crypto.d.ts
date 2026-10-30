/**
 * `node:crypto` 的**最小环境声明**。
 *
 * 为什么需要：本项目未安装 `@types/node`（离线环境无法获取），而根 `tsconfig.base.json`
 * 设了 `"types": []`，因此 `import ... from 'node:crypto'` 会报 TS2307。
 *
 * 取舍：**只声明本包实际用到的两个函数**，签名按 Node 官方语义的最小可满足子集给出，
 * 不伪造额外能力。运行时由 Electron/Node 真实提供 `node:crypto`，不是模拟。
 *
 * 若将来引入 `@types/node`，应删除本文件（否则可能与之冲突）。
 */
declare module 'node:crypto' {
  /** 增量哈希对象（只声明本包用到的两个方法）。 */
  export interface Hash {
    update(data: string | Uint8Array, inputEncoding?: 'utf8'): Hash
    digest(encoding: 'hex'): string
  }

  /** 创建哈希。本包只用 `sha256`。 */
  export function createHash(algorithm: 'sha256'): Hash

  /** 加密安全随机字节；本包只取其 base64url 文本形式。 */
  export function randomBytes(size: number): { toString(encoding: 'base64url'): string }
}
