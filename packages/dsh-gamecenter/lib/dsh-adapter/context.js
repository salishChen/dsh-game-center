/**
 * DSH Host 上下文的**最小结构类型**与运行时适配层。
 *
 * 为什么不用 `any` 也不用 DSH 的 .d.ts：
 * - 本包不 vendor DSH 类型包（安装目录只读，且版本 nightly，类型会漂移）；
 * - 但用 `any` 会让 `@Remote` 装饰器签名、`ctx.typertGateway` 拼写错误在编译期静默通过，
 *   阶段0 必须能靠 `tsc` 捕获拼写/签名错误。
 *
 * 因此这里只声明**本包实际用到的成员**，每个成员都标注了实装源码出处（0.2.1-rc.2 /
 * build 332895e0f7c9d4dbfb29729f5eb367fa263ff986）。任何超出本文件的 DSH 能力
 * 都视为「未核实」，不得在业务代码里直接调用。
 */
export function isMinimalContext(value) {
    return typeof value === 'object' && value !== null && typeof value.effect === 'function';
}
export function isTypertGatewayLike(value) {
    return typeof value === 'object' && value !== null && value.name === 'typertGateway';
}
/**
 * 判断一个值是否是 `TypertRemoteService` 实例（结构化判断，不用 instanceof，
 * 避免跨副本类身份问题 —— DSH 自身也采用结构化判别）。
 */
export function isTypertRemoteServiceLike(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const binding = value.typertRemote;
    return typeof binding === 'object' && binding !== null && typeof binding.namespace === 'string';
}
//# sourceMappingURL=context.js.map