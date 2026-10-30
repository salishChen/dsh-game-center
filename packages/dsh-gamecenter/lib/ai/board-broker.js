export const AI_TIMEOUT_MS = 120_000;
export const AI_OUTPUT_MAX_BYTES = 256 * 1024;
/** One registered DSH adapter generation owns both validation and dispatch. */
export async function generateBoard(llm, binding, slot, input, signal) {
    if (!llm?.prepareCall || slot !== 'boardGeneration')
        throw new Error('未接入可执行的矩阵生成适配器');
    const raw = input;
    if (!raw || !Number.isInteger(raw.rows) || !Number.isInteger(raw.cols) || raw.rows < 1 || raw.cols < 1 || raw.rows > 30 || raw.cols > 30 ||
        !Number.isInteger(raw.mineCount) || raw.mineCount < 0 || raw.mineCount >= raw.rows * raw.cols ||
        !raw.firstClick || !Number.isInteger(raw.firstClick.row) || !Number.isInteger(raw.firstClick.col) ||
        raw.firstClick.row < 0 || raw.firstClick.row >= raw.rows || raw.firstClick.col < 0 || raw.firstClick.col >= raw.cols) {
        throw new Error('非法棋盘尺寸、雷数或首击坐标');
    }
    const start = Date.now();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted)
        onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timer;
    const aborted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('AI 生成已取消或超时'), { name: 'AbortError' })), { once: true });
        if (controller.signal.aborted)
            reject(Object.assign(new Error('AI 生成已取消'), { name: 'AbortError' }));
        timer = setTimeout(() => controller.abort('AI_TIMEOUT'), AI_TIMEOUT_MS);
    });
    const execute = async () => {
        const prepared = await llm.prepareCall({ provider: binding.providerId, model: binding.modelId,
            ...(binding.reasoningEffort === undefined ? {} : { reasoningEffort: binding.reasoningEffort }) }, controller.signal);
        let text = '';
        let finished = false;
        let usage;
        const prompt = `Generate a standard Minesweeper mine matrix. Return ONLY one JSON object {"rows":${raw.rows},"cols":${raw.cols},"matrix":[...]}. matrix must have exactly ${raw.rows} rows and ${raw.cols} columns of integer 0 or 1. Exactly ${raw.mineCount} cells must be 1 (mine). Zero-based first-click cell (${raw.firstClick.row},${raw.firstClick.col}) must be 0. No no-guess guarantee is required. Do not return adjacent counts, code, markdown, explanations or tools.`;
        for await (const chunk of prepared.stream({ ...prepared.config,
            messages: [{ id: `gamecenter-board-${start}`, source: { kind: 'plugin', plugin: '@dsh-gamecenter/host' }, role: 'user', content: [{ type: 'text', text: prompt }] }], signal: controller.signal })) {
            if (controller.signal.aborted)
                throw Object.assign(new Error('AI 请求已取消'), { name: 'AbortError' });
            if (chunk.type === 'text-delta')
                text += chunk.text ?? '';
            if (chunk.type === 'usage')
                usage = JSON.parse(JSON.stringify(chunk.usage));
            if (new TextEncoder().encode(text).byteLength > AI_OUTPUT_MAX_BYTES) {
                controller.abort('OUTPUT_TOO_LARGE');
                throw new Error('模型结果超过 256 KiB');
            }
            if (chunk.type === 'finish') {
                const reason = chunk.reason;
                const kind = typeof reason === 'string' ? reason : reason?.kind;
                if (kind !== 'stop')
                    throw new Error(`模型未正常完成：${kind}`);
                finished = true;
            }
        }
        if (!finished || text.trim() === '')
            throw new Error('模型未返回完整文本结果');
        const config = prepared.config;
        return { output: JSON.parse(text.trim()),
            binding: { providerId: config.provider, modelId: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) },
            elapsedMs: Date.now() - start, ...(usage === undefined ? {} : { usage }) };
    };
    try {
        return await Promise.race([execute(), aborted]);
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=board-broker.js.map