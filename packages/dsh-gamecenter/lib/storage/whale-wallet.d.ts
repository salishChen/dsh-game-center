export declare const FLASH_GAME = "example.crazy-flasher4";
export declare function hasWhaleWallet(gameId: string): gameId is "example.cat-arena" | "example.crazy-flasher4";
/** Host-owned ledger. Neither token counts nor whale credits are accepted over RPC. */
export declare class WhaleWallet {
    readonly playerId: string;
    private readonly db;
    private closed;
    meterActive: boolean;
    constructor(dbPath?: string, playerId?: string, nowMs?: number);
    close(): void;
    private transaction;
    status(): {
        history: {
            error?: string;
            status: string;
            from: number;
            to: number;
            tokens: number;
            calls: number;
            scannedSessions: number;
            totalSessions: number;
        };
        balance: number;
        totalTokens: number;
        nextRewardIn: number;
        earned: number;
        meterActive: boolean;
        scope: string;
        rate: {
            tokens: number;
            coins: number;
            goldPerCoin: number;
        };
    };
    /** Cumulative snapshots for one real stream; retries are separate stream identities. */
    observeUsage(id: string, usage: unknown): void;
    historyProgress(status: 'scanning' | 'failed', scanned?: number, sessions?: number, error?: string): void;
    /** Entire historical grant and completion marker commit together. Reruns never reissue coins. */
    finishHistory(rows: {
        id: string;
        tokens: number;
    }[]): {
        error?: string;
        status: string;
        from: number;
        to: number;
        tokens: number;
        calls: number;
        scannedSessions: number;
        totalSessions: number;
    };
    private game;
    command(input: Record<string, any>, gameId?: string): any;
}
/** DSH llm.streamWithRegistration uses ctx.waterfall(this,'llm/stream',options,next).
 * Observe raw usage only; never retain messages, reasoning or credentials. */
export declare function attachWhaleMeter(ctx: {
    on?: (event: string, listener: (...args: any[]) => any, options?: {
        global?: boolean;
        prepend?: boolean;
    }) => any;
}, wallet: WhaleWallet): () => void;
