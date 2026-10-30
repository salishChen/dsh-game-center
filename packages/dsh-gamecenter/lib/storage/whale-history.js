import { createHash } from 'node:crypto';
/** Read canonical owned events, including failed attempts; never the visible surface.
 * readSession supplies the exact fork cut, so parent history is counted only at its owner. */
export function historicalSessionUsage(id, log, from, to) {
    if (log.session?.id !== id || !Number.isSafeInteger(log.inheritedEventCount) || log.inheritedEventCount < 0 || !Array.isArray(log.events))
        throw Error('DSH 会话历史格式不完整');
    const out = [];
    for (const event of log.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq < log.inheritedEventCount || !['assistant/message', 'assistant/attempt'].includes(event.type))
            continue;
        if (typeof event.time !== 'number' || !Number.isFinite(event.time))
            throw Error('DSH 用量记录缺少时间');
        if (event.time < from || event.time >= to)
            continue;
        const candidates = [event.data?.usage, ...(event.data?.stream || []).filter((r) => r.type === 'chunk' && r.chunk?.type === 'usage').map((r) => r.chunk.usage)];
        const totals = candidates.map(u => u?.totalTokens).filter(n => Number.isSafeInteger(n) && n >= 0);
        if (!totals.length)
            continue;
        out.push({ id: 'history:' + createHash('sha256').update(JSON.stringify([id, event.seq, event.type]), 'utf8').digest('hex'), tokens: Math.max(...totals) });
    }
    return out;
}
export class WhaleHistoryBootstrap {
    wallet;
    query;
    now;
    stopped = false;
    task;
    retryAfter = 0;
    constructor(wallet, query, now = () => Date.now()) {
        this.wallet = wallet;
        this.query = query;
        this.now = now;
    }
    start() {
        if (this.stopped || this.task || this.now() < this.retryAfter || !['pending', 'failed', 'scanning'].includes(this.wallet.status().history.status))
            return this.task;
        this.task = this.run().finally(() => { this.task = undefined; });
        return this.task;
    }
    stop() { this.stopped = true; }
    async run() {
        try {
            const window = this.wallet.status().history;
            this.wallet.historyProgress('scanning', 0, 0);
            const sessions = await this.query.listSessions();
            if (this.stopped)
                return;
            const ids = [...new Set(sessions.map(s => s.header.id))], usage = new Map();
            let scanned = 0;
            this.wallet.historyProgress('scanning', scanned, ids.length);
            // Sequential reads bound resident dialogue data to one Session; only counts survive each read.
            for (const id of ids) {
                const log = await this.query.readSession(id);
                if (this.stopped)
                    return;
                for (const row of historicalSessionUsage(id, log, window.from, window.to))
                    usage.set(row.id, Math.max(usage.get(row.id) || 0, row.tokens));
                this.wallet.historyProgress('scanning', ++scanned, ids.length);
            }
            if (!this.stopped)
                this.wallet.finishHistory([...usage].map(([id, tokens]) => ({ id, tokens })));
        }
        catch (e) {
            if (!this.stopped) {
                this.retryAfter = this.now() + 60_000;
                this.wallet.historyProgress('failed', undefined, undefined, e instanceof Error ? e.message : 'DSH 历史读取失败');
            }
        }
    }
}
/** Optional service binding follows DSH SessionCorpus's ctx.inject pattern. */
export function attachWhaleHistory(ctx, wallet) {
    let job, disposed = false;
    const fiber = ctx.inject?.(['sessionQuery', 'sessionPersistence'], child => {
        if (disposed)
            return;
        job?.stop();
        const current = new WhaleHistoryBootstrap(wallet, child.sessionQuery);
        job = current;
        void current.start();
        child.effect(() => () => { current.stop(); if (job === current)
            job = undefined; }, 'gamecenter: historical token grant');
    });
    return { start: () => { if (!disposed)
            void job?.start(); }, dispose: () => { disposed = true; job?.stop(); void fiber?.dispose(); } };
}
//# sourceMappingURL=whale-history.js.map