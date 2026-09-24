export type Action = "buy" | "sell" | "hold";
export type Side = "buy" | "sell";
/** This block's post-only limit order. `sent` until its receipt lands, then `placed` or `reverted`. */
export interface Quote { side: Side; price: number; size: number; txHash: string | null; ref?: string | null; gasMon: number; cancel: (number | string)[]; status: "sent" | "placed" | "reverted" | "lost" | "sim"; orderId: number | string | null; capped: boolean; close?: string; overSkip?: boolean }
/** A taker hit one of our resting orders. */
export interface Fill { side: Side; size: number; price: number; txHash: string | null; orderId: number | string; simulated: boolean; fee?: number }
export interface Decision { action: Action; probabilities: { buy: number; sell: number; hold: number }; upIn10: number; latencyMs: number; late: boolean }
export interface Position { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number }
export interface Totals { blocks: number; decisions: number; quotes: number; fills: number; reverted: number; lateBlocks: number; jevUsd: number; gasMon: number; gasUsd: number; feesUsd?: number; realizedUsd: number; pnlUsd: number; pnlMon: number; pnlPct: number }
export interface BlockEvent { block: number; ts: number; mid: number; bestBid: number; bestAsk: number; spreadBps: number; decision: Decision | null; quote: Quote | null; fill: Fill | null; resting: { bidMon: number; askMon: number }; position: Position; closing?: string | null; totals: Totals }
/** Which exchange the server trades on. Money fields named ...Usd are in `quoteCcy`; size fields named ...Mon are in `base`. */
export interface VenueInfo { name: "kuru" | "okx"; label: string; market: string; symbol: string; base: string; quoteCcy: string; priceDecimals: number; sizeDecimals: number; clock: "block" | "tick"; txUrl: string | null }
/** `wallet` is the Kuru wallet address, or an OKX account label. `venue` is absent on older servers (Kuru). */
export interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; venue?: VenueInfo; startedAt: number }
export type ConnectionState = "connecting" | "live" | "reconnecting";
export interface FeedState { meta: Meta | null; events: BlockEvent[]; latest: BlockEvent | null; connection: ConnectionState; avgLatencyMs: number }
