import type { DshLlmLike } from '../dsh-adapter/context.js';
import { type ArenaPreviousRound, type ArenaAiTrace, type AiModelBinding, type JsonValue } from '@dsh-gamecenter/protocol';
/** Only canonical Host-retained previous-round builds may be disclosed; no current player build or iframe prompt. */
export declare function arenaBuildPrompt(previousRound?: ArenaPreviousRound): string;
/** Leave room for the RPC envelope under the 256 KiB iframe bridge limit. */
export declare function arenaReviewTraces(source: ArenaAiTrace[]): ArenaAiTrace[];
export declare function generateArenaBuild(llm: DshLlmLike | undefined, binding: AiModelBinding, signal?: AbortSignal, onTrace?: (value: Partial<ArenaAiTrace>) => void, previousRound?: ArenaPreviousRound): Promise<{
    usage?: JsonValue;
    output: JsonValue;
    binding: {
        reasoningEffort?: any;
        providerId: any;
        modelId: any;
    };
    elapsedMs: number;
}>;
