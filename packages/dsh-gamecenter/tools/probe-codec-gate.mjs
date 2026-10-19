/**
 * 只读探针：核实「挂载路径」与「registry 校验层」谁才是真门禁，
 * 以及 src-json codec 在挂载路径上是否会被拒。
 *
 * 争议点：架构与协议负责人称 typert-registry 的 validateCodec 对 src-json 直接放行；
 * Host 工程师在 gateway client 的 requireStrictInputs 里看到 strict 是硬要求。
 * 本探针在同一份实装源码里同时取两处，让冲突可见，而不是各说各话。
 *
 * 用法：node tools/probe-codec-gate.mjs [asarPath]
 */
import fs from 'node:fs'

const asarPath = process.argv[2] ?? 'D:/Program Files/deepseek harness/resources/app.asar'

const fd = fs.openSync(asarPath, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const jsonLen = head.readUInt32LE(12)
  const jsonBuf = Buffer.alloc(jsonLen)
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
  const header = JSON.parse(jsonBuf.toString('utf8'))
  const base = 16 + jsonLen

  const read = (innerPath) => {
    let cur = header
    for (const part of innerPath.split('/')) {
      cur = cur?.files?.[part]
      if (!cur) throw new Error(`not in asar: ${innerPath}`)
    }
    const buf = Buffer.alloc(cur.size)
    fs.readSync(fd, buf, 0, cur.size, base + Number(cur.offset))
    return buf.toString('utf8')
  }

  const show = (label, src, needle, span = 1100) => {
    const at = src.indexOf(needle)
    console.log(`\n### ${label} :: ${needle} @${at}`)
    if (at >= 0) console.log(src.slice(Math.max(0, at - 400), at + span))
    return at
  }

  // ---------- A. gateway client：挂载路径 ----------
  const gw = read('dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/client.browser.js')
  console.log('========== A. dsh-api-gateway/lib/client.browser.js ==========')
  show('requireStrictInputs', gw, 'function requireStrictInputs')
  show('requireStrictCodec', gw, 'function requireStrictCodec', 400)
  show('mountContribution 调用点', gw, 'async mountContribution', 1200)
  show('$mount 定义', gw, 'async $mount(contribution)', 900)

  // .encode( 是否真的不存在
  const encodeHits = (gw.match(/\.encode\(/g) ?? []).length
  const decodeHits = (gw.match(/\.decode\(/g) ?? []).length
  console.log(`\n统计：.encode( 命中 ${encodeHits} 次；.decode( 命中 ${decodeHits} 次`)

  // ---------- B. typert-registry：registry 层 ----------
  const reg = read('dsh/node_modules/@deepseek-ai/dsh-typert-registry/lib/client.browser.js')
  console.log('\n========== B. dsh-typert-registry/lib/client.browser.js ==========')
  show('validateCodec', reg, 'function validateCodec')
  show('validateInvocation', reg, 'function validateInvocation', 1500)
  show('RemoteStore.register', reg, 'register(ctx, contribution)', 1200)
  show('view() 返回', reg, 'view(ctx)', 800)

  // ---------- C. 判定 ----------
  console.log('\n========== C. 判定 ==========')
  const strictInGateway = /codec\.mode !== "strict"/.test(gw)
  console.log(`  网关挂载路径是否硬性要求 strict: ${strictInGateway ? '是' : '否'}`)
  const srcJsonAllowedInRegistry = /src-json/.test(reg) && /mode === "src-json"/.test(reg)
  console.log(`  registry 层是否放行 src-json: ${srcJsonAllowedInRegistry ? '是' : '否（或写法不同）'}`)
  console.log('  说明：两者不矛盾——registry 校验在 register 时执行，gateway 校验在 $mount 时更早执行。')
  console.log('        若 gateway 先抛，src-json 根本走不到 registry。需看调用顺序。')
  show('mountContribution 内的先后顺序', gw, 'validateContribution(contribution)', 700)
  show('mountContribution 内 remotes.register 位置', gw, 'typert.remotes.register', 500)
} finally {
  fs.closeSync(fd)
}
