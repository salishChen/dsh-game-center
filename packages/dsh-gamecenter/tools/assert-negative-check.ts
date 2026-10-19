/**
 * 负例验证：证明 `Assert<T extends true>` 形式的类型一致性断言**真的会失败**。
 *
 * 做法：复制 lease.ts 的断言结构，故意用一个"漏字段"的本地类型，
 * 期望 tsc 报 TS2344。若本脚本能正常编译通过，说明断言是假的。
 *
 * 用法：npx tsc --strict --noEmit --target ES2022 tools/assert-negative-check.ts
 *      期望退出码非 0。
 */
import type { RuntimeLease } from '@dsh-gamecenter/protocol'

type Assert<T extends true> = T

/** 故意漏掉 `sealed` 字段的"坏实现"。 */
interface BrokenLease {
  runtimeInstanceId: string
  generation: number
  gameId: string
  saveId: string
  expiresAt: string
  // 缺 sealed
}

// 期望：这一行触发 TS2344（Type 'false' does not satisfy the constraint 'true'）。
type _ShouldFail = Assert<BrokenLease extends RuntimeLease ? true : false>

/**
 * 另一条：字段类型被悄悄改宽。
 * `expiresAt` 协议是 string，这里写成 string | undefined，
 * 左向 extends 会失败。
 */
interface WidenedLease extends Omit<RuntimeLease, 'expiresAt'> {
  expiresAt: string | undefined
}

// 期望：这一行同样触发 TS2344。
type _ShouldFailWidened = Assert<WidenedLease extends RuntimeLease ? true : false>

export type { _ShouldFail, _ShouldFailWidened }
