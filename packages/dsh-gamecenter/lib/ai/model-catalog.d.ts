/**
 * 模型目录的**只读脱敏投影**（基线 §5.1、§5.2）。
 *
 * 严格边界（阶段0 必须成立）：
 * 1. 只调用 `ctx.llm.listProviders()` / `listModels(provider)`，**绝不**调用 `stream()`
 *    或任何会产费用的能力探测。
 * 2. DSH 目录里的信息只证明「DSH 声明了什么」，**不能**推出：
 *    - 图像输出能力（目录只有输入模态）；
 *    - 端点真实可用（需要适配器确认）；
 *    因此 `status` 一律给 `unknown`，除非有独立 adapter 证据。
 * 3. 绝不输出凭据、baseURL、account、token。字段白名单在这里执行，
 *    而不是「记得别传」。
 */
import type { ModelCapabilityEntry } from '@dsh-gamecenter/protocol';
/**
 * 能力条目直接复用协议权威类型（`ModelCapabilityEntry` / `Modality` / `ModelLimits`）。
 *
 * 历史：protocol 曾以源码路径导出导致下游 emit 冲突，我内联过一套
 * `Catalog*` 结构子集，造成两套契约漂移（测试与发布负责人指出）。
 * 架构与协议负责人已把 protocol 改为 `dist` 产物 + 类型声明，
 * 内联变通已删除。**不要再内联协议类型。**
 * 这里必须用 `import type`：值导入会让产物带上外部包依赖，宿主解析不到。
 */
import type { DshLlmLike } from '../dsh-adapter/context.js';
/**
 * 把 DSH 的模型描述对象收敛成能力条目。
 *
 * DSH 目录对象的具体形状在不同版本可能不同，因此这里**不猜字段类型**：
 * 只读取能明确识别的 `id` / `model` / `name` 与模态相关字段，
 * 读不到就留 `unknown`（基线：元数据缺失表示 unknown，不默认支持）。
 */
export declare function projectModelEntry(input: {
    providerId: string;
    model: unknown;
    adapterId?: string;
    verifiedAt?: string;
    adapterVersion?: string;
}): ModelCapabilityEntry | null;
/**
 * 断言一个条目只包含白名单字段（负例测试与审计用）。
 * 不用 `Object.keys` 之外的反射，避免把原型链上的东西算进去。
 */
export declare function assertNoSensitiveFields(entry: ModelCapabilityEntry): string[];
export interface ModelCatalogResult {
    entries: ModelCapabilityEntry[];
    /** 读取失败的 provider 与该失败原因（脱敏，只保留错误名与消息）。 */
    failures: {
        providerId: string;
        error: string;
    }[];
    /** 是否完成了目录读取；false 表示 ctx.llm 不可用，界面必须显示"目录不可用"而不是空列表。 */
    available: boolean;
}
/**
 * 读取完整目录。**只读**：不含任何 stream/探测调用。
 *
 * @param llm - DSH `ctx.llm` 子集；不可用时传 undefined。
 */
export declare function readModelCatalog(llm: DshLlmLike | undefined, adapterId?: string): Promise<ModelCatalogResult>;
