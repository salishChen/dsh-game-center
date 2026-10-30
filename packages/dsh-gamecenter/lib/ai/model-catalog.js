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
/** 允许出现在投影结果里的字段（白名单）。 */
const ALLOWED_ENTRY_KEYS = [
    'name',
    'reasoning',
    'providerId',
    'modelId',
    'adapterId',
    'operations',
    'inputModalities',
    'outputModalities',
    'streaming',
    'structuredOutput',
    'limits',
    'status',
    'evidence',
    'verifiedAt',
    'adapterVersion',
];
const KNOWN_MODALITIES = ['text', 'image', 'audio', 'video'];
/**
 * 把 DSH 的模型描述对象收敛成能力条目。
 *
 * DSH 目录对象的具体形状在不同版本可能不同，因此这里**不猜字段类型**：
 * 只读取能明确识别的 `id` / `model` / `name` 与模态相关字段，
 * 读不到就留 `unknown`（基线：元数据缺失表示 unknown，不默认支持）。
 */
export function projectModelEntry(input) {
    const { providerId, model } = input;
    if (typeof model !== 'object' || model === null)
        return null;
    const raw = model;
    const modelId = firstString(raw['id'], raw['model'], raw['name']);
    if (modelId === undefined || modelId.length === 0)
        return null;
    // DSH 观测到的输入模态字段名优先；未识别出来的保持空数组 = unknown。
    const inputModalities = normalizeModalities(raw['inputModalities'] ?? raw['input'] ?? raw['modalities'] ?? raw['inputTypes']);
    return {
        providerId,
        modelId,
        adapterId: input.adapterId ?? 'dsh-llm',
        // 目录只证明「可作为文本推理候选」，不证明其它操作。
        operations: ['chat.generate'],
        inputModalities,
        // 目录从不声明输出模态 → 保持空数组，绝不由输入推出输出。
        outputModalities: [],
        streaming: 'unknown',
        structuredOutput: 'unknown',
        limits: readLimits(raw),
        // 没有 adapter 证据就是 unknown（基线 §5.1）。
        status: 'unknown',
        evidence: 'dsh-catalog',
        verifiedAt: input.verifiedAt ?? new Date(0).toISOString(),
        adapterVersion: input.adapterVersion ?? '0.0.0-unverified',
    };
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
function normalizeModalities(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const item of value) {
        if (typeof item !== 'string')
            continue;
        if (!KNOWN_MODALITIES.includes(item))
            continue;
        if (out.includes(item))
            continue;
        out.push(item);
    }
    return out;
}
function readLimits(raw) {
    const limitSource = typeof raw['limits'] === 'object' && raw['limits'] !== null
        ? raw['limits']
        : raw;
    const limits = {};
    const context = firstNumber(limitSource['contextTokens'], limitSource['contextWindow'], limitSource['context']);
    if (context !== undefined)
        limits.contextTokens = context;
    const output = firstNumber(limitSource['outputTokens'], limitSource['maxOutputTokens']);
    if (output !== undefined)
        limits.outputTokens = output;
    const images = firstNumber(limitSource['maxImagesPerRequest']);
    if (images !== undefined)
        limits.maxImagesPerRequest = images;
    return limits;
}
function firstNumber(...values) {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
            return value;
    }
    return undefined;
}
/**
 * 断言一个条目只包含白名单字段（负例测试与审计用）。
 * 不用 `Object.keys` 之外的反射，避免把原型链上的东西算进去。
 */
export function assertNoSensitiveFields(entry) {
    const extra = Object.keys(entry).filter((key) => !ALLOWED_ENTRY_KEYS.includes(key));
    const suspicious = ['apiKey', 'token', 'baseURL', 'baseUrl', 'account', 'password', 'secret'];
    for (const key of Object.keys(entry)) {
        if (suspicious.includes(key))
            extra.push(key);
    }
    return extra;
}
function errorText(error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
/**
 * 读取完整目录。**只读**：不含任何 stream/探测调用。
 *
 * @param llm - DSH `ctx.llm` 子集；不可用时传 undefined。
 */
export async function readModelCatalog(llm, adapterId = 'dsh-llm') {
    if (llm === undefined) {
        return { entries: [], failures: [], available: false };
    }
    const failures = [];
    const entries = [];
    let providers;
    try {
        providers = await llm.listProviders();
    }
    catch (error) {
        return { entries: [], failures: [{ providerId: '*', error: errorText(error) }], available: false };
    }
    for (const provider of providers) {
        const providerId = typeof provider === 'string'
            ? provider
            : (typeof provider === 'object' && provider !== null
                ? firstString(provider['id'], provider['name'])
                : undefined);
        if (providerId === undefined)
            continue;
        try {
            const models = await llm.listModels(providerId);
            for (const model of models) {
                const entry = projectModelEntry({ providerId, model, adapterId });
                if (entry !== null) {
                    try {
                        if (llm.resolveModelInfo) {
                            const info = await llm.resolveModelInfo(providerId, entry.modelId);
                            if (typeof info.name === 'string')
                                entry.name = info.name;
                            if (info.reasoning && Array.isArray(info.reasoning.efforts)) {
                                entry.reasoning = { efforts: info.reasoning.efforts.filter((e) => typeof e.id === 'string' && typeof e.name === 'string').map((e) => ({ id: e.id, name: e.name })),
                                    ...(typeof info.reasoning.defaultEffort === 'string' ? { defaultEffort: info.reasoning.defaultEffort } : {}) };
                            }
                        }
                    }
                    catch (error) {
                        failures.push({ providerId, error: errorText(error) });
                    }
                    entries.push(entry);
                }
            }
        }
        catch (error) {
            failures.push({ providerId, error: errorText(error) });
        }
    }
    return { entries, failures, available: true };
}
//# sourceMappingURL=model-catalog.js.map