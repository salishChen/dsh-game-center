import type { AiModelBinding } from '@dsh-gamecenter/protocol';
export interface TokenUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
/** Only DSH's documented counters, never provider metadata or credentials. Snapshots are cumulative. */
export declare function tokenUsage(raw: unknown): TokenUsage;
export interface LandlordCallTrace {
    operationId: string;
    seat: number;
    revision: number;
    startedAt: string;
    requestedBinding?: AiModelBinding;
    binding?: AiModelBinding;
    prompt?: string;
    response?: string;
    elapsedMs: number;
    usage: TokenUsage;
    status: 'success' | 'failed' | 'cancelled' | 'local';
    source: 'ai' | 'local' | 'none';
    error?: string;
    action?: {
        bid?: number;
        cards?: number[];
    };
}
export declare function summarizeCalls(calls: LandlordCallTrace[]): {
    modelCalls: number;
    localDecisions: number;
    totals: TokenUsage;
    reportedCalls: Record<string, number>;
};
