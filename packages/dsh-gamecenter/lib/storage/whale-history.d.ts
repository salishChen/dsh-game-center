import type { WhaleWallet } from './whale-wallet.js';
export interface SessionUsageQuery {
    listSessions(): Promise<{
        header: {
            id: string;
        };
    }[]>;
    readSession(id: string): Promise<{
        session: {
            id: string;
        };
        inheritedEventCount: number;
        events: any[];
    }>;
}
/** Read canonical owned events, including failed attempts; never the visible surface.
 * readSession supplies the exact fork cut, so parent history is counted only at its owner. */
export declare function historicalSessionUsage(id: string, log: Awaited<ReturnType<SessionUsageQuery['readSession']>>, from: number, to: number): {
    id: string;
    tokens: number;
}[];
export declare class WhaleHistoryBootstrap {
    private readonly wallet;
    private readonly query;
    private readonly now;
    private stopped;
    private task;
    private retryAfter;
    constructor(wallet: WhaleWallet, query: SessionUsageQuery, now?: () => number);
    start(): Promise<void> | undefined;
    stop(): void;
    private run;
}
/** Optional service binding follows DSH SessionCorpus's ctx.inject pattern. */
export declare function attachWhaleHistory(ctx: {
    inject?: (keys: string[], callback: (ctx: any) => void) => {
        dispose: () => unknown;
    };
}, wallet: WhaleWallet): {
    start: () => void;
    dispose: () => void;
};
