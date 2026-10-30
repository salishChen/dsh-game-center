import type { DshLlmLike } from '../dsh-adapter/context.js';
import type { AiModelBinding, JsonValue } from '@dsh-gamecenter/protocol';
export declare const AI_TIMEOUT_MS = 120000;
export declare const AI_OUTPUT_MAX_BYTES: number;
/** One registered DSH adapter generation owns both validation and dispatch. */
export declare function generateBoard(llm: DshLlmLike | undefined, binding: AiModelBinding, slot: string, input: unknown, signal?: AbortSignal): Promise<{
    output: JsonValue;
    binding: AiModelBinding;
    elapsedMs: number;
    usage?: JsonValue;
}>;
