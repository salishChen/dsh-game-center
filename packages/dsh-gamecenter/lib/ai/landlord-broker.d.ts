import type { DshLlmLike } from '../dsh-adapter/context.js';
import type { AiModelBinding } from '@dsh-gamecenter/protocol';
import type { LandlordView } from '../games/landlord-engine.js';
import { type LandlordCallTrace } from '../games/landlord-review.js';
/** Receives an already-redacted seat view, never a LandlordState or a cross-seat conversation. */
export declare function generateLandlordDecision(llm: DshLlmLike | undefined, binding: AiModelBinding, view: LandlordView, signal?: AbortSignal, report?: (trace: Pick<LandlordCallTrace, 'prompt' | 'response' | 'binding' | 'elapsedMs' | 'usage' | 'status' | 'error'>) => void): Promise<{
    usage?: import("../games/landlord-review.js").TokenUsage;
    action: {
        bid?: number;
        cards?: number[];
    };
    binding: AiModelBinding;
    elapsedMs: number;
}>;
