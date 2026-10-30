import { ARENA_BUILD_SKILL, ARENA_PARTS, ARENA_SLOTS, ARENA_PRICES, ARENA_UPGRADE_COSTS, ARENA_DUEL_BUDGET, quoteArenaPlan } from '@dsh-gamecenter/protocol';
import { AI_TIMEOUT_MS, AI_OUTPUT_MAX_BYTES } from './board-broker.js';
/** Only canonical Host-retained previous-round builds may be disclosed; no current player build or iframe prompt. */
export function arenaBuildPrompt(previousRound) { return ARENA_BUILD_SKILL + '\n本局规则与实际数值：\n' + JSON.stringify({ budget: ARENA_DUEL_BUDGET, parts: ARENA_PARTS, slots: ARENA_SLOTS, prices: ARENA_PRICES, upgradeCosts: ARENA_UPGRADE_COSTS, bonuses: false, recharge: false, opponentLoadout: 'not disclosed', previousRound: previousRound ?? null }); }
/** Leave room for the RPC envelope under the 256 KiB iframe bridge limit. */
export function arenaReviewTraces(source) {
    const traces = structuredClone(source).map(t => ({ ...t, feedback: t.feedback.slice(0, 1024) })), bytes = () => new TextEncoder().encode(JSON.stringify(traces)).byteLength;
    while (bytes() > 192 * 1024) {
        const longest = traces.reduce((a, b) => !a || b.response.length > a.response.length ? b : a, undefined);
        if (!longest?.response.length)
            break;
        longest.response = longest.response.slice(0, Math.floor(longest.response.length / 2));
        longest.responseTruncated = true;
    }
    return traces;
}
export async function generateArenaBuild(llm, binding, signal, onTrace, previousRound) {
    const start = Date.now(), controller = new AbortController(), abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        abort();
    let timer, sealed = false;
    const cancelled = new Promise((_, reject) => {
        const fail = () => reject(Object.assign(Error(controller.signal.reason === 'AI_TIMEOUT' ? 'AI 组装超过 120 秒' : 'AI 组装已取消'), { name: 'AbortError' }));
        controller.signal.addEventListener('abort', fail, { once: true });
        if (controller.signal.aborted)
            fail();
        timer = setTimeout(() => controller.abort('AI_TIMEOUT'), AI_TIMEOUT_MS);
    });
    let text = '', usage;
    const publish = (status, feedback) => !sealed && onTrace?.({ status, binding, request: arenaBuildPrompt(previousRound), response: text, feedback, elapsedMs: Date.now() - start, ...(usage === undefined ? {} : { usage }) });
    publish('pending', '模型正在独立组装，你可以继续改装自己的战车。');
    const execute = async () => {
        if (controller.signal.aborted)
            throw Object.assign(Error('已取消'), { name: 'AbortError' });
        if (!llm?.prepareCall)
            throw Error('模型执行适配器未就绪，请在运行工具栏选择模型');
        const prepared = await llm.prepareCall({ provider: binding.providerId, model: binding.modelId, ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }) }, controller.signal);
        if (sealed || controller.signal.aborted)
            throw Object.assign(Error('已取消'), { name: 'AbortError' });
        const prompt = arenaBuildPrompt(previousRound);
        let finished = false;
        for await (const chunk of prepared.stream({ ...prepared.config, tools: [], messages: [{ id: `arena-${start}`, source: { kind: 'plugin', plugin: '@dsh-gamecenter/host' }, role: 'user', content: [{ type: 'text', text: prompt }] }], signal: controller.signal })) {
            if (sealed || controller.signal.aborted)
                throw Object.assign(Error('已取消'), { name: 'AbortError' });
            if (chunk.type === 'text-delta') {
                const delta = chunk.text ?? '';
                if (new TextEncoder().encode(text).byteLength + new TextEncoder().encode(delta).byteLength > AI_OUTPUT_MAX_BYTES) {
                    text = (text + delta.slice(0, AI_OUTPUT_MAX_BYTES / 4)).slice(0, AI_OUTPUT_MAX_BYTES / 4);
                    throw Error('模型输出超过 256 KiB');
                }
                text += delta;
                publish('pending', '正在接收模型回复…');
            }
            if (chunk.type === 'usage')
                usage = JSON.parse(JSON.stringify(chunk.usage));
            if (new TextEncoder().encode(text).byteLength > AI_OUTPUT_MAX_BYTES) {
                controller.abort('OUTPUT_TOO_LARGE');
                throw Error('模型输出超过 256 KiB');
            }
            if (chunk.type === 'finish') {
                const reason = chunk.reason;
                if ((typeof reason === 'string' ? reason : reason?.kind) !== 'stop')
                    throw Error('模型未正常完成组装');
                finished = true;
            }
        }
        if (!finished || !text.trim())
            throw Error('模型未返回完整组装方案');
        const quote = quoteArenaPlan(JSON.parse(text.trim()));
        publish('succeeded', `方案校验通过：${quote.cost} / ${ARENA_DUEL_BUDGET} 金币，电力 ${quote.used} / ${quote.available}。`);
        return { output: JSON.parse(JSON.stringify(quote.plan)), binding: { providerId: prepared.config.provider, modelId: prepared.config.model, ...(prepared.config.reasoningEffort === undefined ? {} : { reasoningEffort: prepared.config.reasoningEffort }) }, elapsedMs: Date.now() - start, ...(usage === undefined ? {} : { usage }) };
    };
    try {
        return await Promise.race([execute(), cancelled]);
    }
    catch (error) {
        publish(controller.signal.aborted && controller.signal.reason !== 'AI_TIMEOUT' ? 'cancelled' : 'failed', error instanceof Error ? error.message : '生成失败');
        throw error;
    }
    finally {
        sealed = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    }
}
//# sourceMappingURL=arena-broker.js.map