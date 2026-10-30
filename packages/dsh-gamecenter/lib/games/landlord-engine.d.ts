/** Authoritative, in-memory three-seat Dou Dizhu. Hidden hands never cross this module's view boundary. */
export type Seat = 0 | 1 | 2;
export type Play = {
    kind: string;
    length: number;
    high: number;
    chain: number;
};
export type Move = {
    cards: number[];
    label: string;
};
export type LandlordState = {
    revision: number;
    phase: 'bidding' | 'playing' | 'finished';
    hands: number[][];
    bottom: number[];
    turn: Seat;
    landlord: Seat | null;
    bids: {
        seat: Seat;
        score: number;
    }[];
    highestBid: number;
    last: {
        seat: Seat;
        cards: number[];
        combo: Play;
    } | null;
    passes: number;
    history: {
        seat: Seat;
        cards: number[];
    }[];
    winner: Seat | null;
    redeals: number;
};
export declare const rank: (card: number) => number;
export declare const cardName: (card: number) => string;
export declare function classify(cards: number[]): Play | null;
export declare function beats(next: Play, previous: Play | null): boolean;
export declare function createLandlordGame(random?: () => number, redeals?: number): LandlordState;
/** Candidate generation consults only the current hand and public last play, never opponents' hands. */
export declare function legalMoves(hand: number[], last: Play | null): Move[];
export declare function applyLandlordAction(state: LandlordState, seat: Seat, action: {
    bid?: number | undefined;
    cards?: number[] | undefined;
}): void;
/** The sole information boundary for human UI, model prompts and local fallback policy. No state spread. */
export declare function landlordSeatView(state: LandlordState, seat: Seat): {
    revision: number;
    phase: "bidding" | "playing" | "finished";
    seat: Seat;
    turn: Seat;
    landlord: Seat | null;
    ownHand: number[];
    bottomCards: number[];
    bids: {
        seat: Seat;
        score: number;
    }[];
    highestBid: number;
    history: {
        seat: Seat;
        cards: number[];
    }[];
    remainingCounts: number[];
    last: {
        seat: Seat;
        cards: number[];
        combo: {
            kind: string;
            length: number;
            high: number;
            chain: number;
        };
    } | null;
    legalBids: number[];
    legalMoves: Move[];
    winner: Seat | null;
    winningSide: string | null;
    redeals: number;
};
export type LandlordView = ReturnType<typeof landlordSeatView>;
export declare function localLandlordDecision(view: LandlordView): {
    bid?: number;
    cards?: number[];
};
