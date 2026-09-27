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
export interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; venue?: VenueInfo; startedAt: number; strategy?: "mm" | "spike" }

/** GET /spike (STRATEGY=spike). See src/spike.ts SpikeSnapshot. */
export type Who = "jev" | "fade" | "follow";
export interface SpikeTrade { side: Side; reason: string; pnlPct: number; roePct: number; pnlUsd: number }
export interface SpikeRow {
  block: number; ts: number; window: "1m" | "3m"; direction: "up" | "down"; movePct: number; mid: number; asked: boolean;
  jev: { action: Action; probabilities: { buy: number; sell: number; hold: number }; latencyMs: number } | null;
  trade: SpikeTrade | null; jevOpen: boolean;
}
export interface SpikeSnapshot {
  plan: { move1mPct: number; move3mPct: number; takeProfitRoePct: number; stopLossRoePct: number; takeProfitPct: number; stopLossPct: number; leverage: number; maxHoldMin: number; size: number; base: string };
  gauge: { r1Pct: number | null; r3Pct: number | null; cooldownSec: number };
  open: { who: Who; side: Side; entry: number; tp: number; sl: number; heldMin: number; unrealizedPct: number; unrealizedRoePct: number }[];
  stats: Record<Who, { trades: number; wins: number; avgPct: number; totalUsd: number; tp: number; sl: number; time: number }>;
  spikes: SpikeRow[];
  curve: { ts: number; jev: number; fade: number; follow: number }[];
}
export type ConnectionState = "connecting" | "live" | "reconnecting";
export interface FeedState { meta: Meta | null; events: BlockEvent[]; latest: BlockEvent | null; connection: ConnectionState; avgLatencyMs: number }
