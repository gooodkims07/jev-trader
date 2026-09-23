/**
 * The exchange boundary. The Trader, the model and the server only talk to a `Venue`; everything
 * specific to one exchange (Kuru on Monad, Upbit) lives behind it.
 *
 * Time is counted in "blocks": Monad blocks on Kuru, 300 ms clock ticks on Upbit. Money fields named
 * `...Usd` elsewhere are in the venue's quote currency (`quoteCcy`: USDC on Kuru, KRW on Upbit).
 */

export type Side = "buy" | "sell";

/** Kuru order ids are numbers; Upbit order ids are uuids. Negative numbers are simulated orders. */
export type OrderId = number | string;

export interface Book {
  block: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBps: number;
  /** (bidDepth - askDepth) / (bidDepth + askDepth) within 1% of mid. -1..1 */
  imbalance: number;
  /** Top 5 levels each side, best first: [price, size]. */
  levels: { bids: [number, number][]; asks: [number, number][] };
  /** Cumulative MON depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
}

/**
 * This block's order: a post-only limit order resting on the book, replacing last block's.
 * `sent` until the venue confirms it, then `placed` (with its orderId) or `reverted` (it would have
 * crossed, or the venue rejected it). `lost` if no confirmation ever came.
 */
export interface Quote {
  side: Side;
  price: number; // quote currency per MON, tick aligned
  size: number; // MON
  /** Kuru: the transaction. Upbit: always null (no chain). */
  txHash: string | null;
  /** The venue's handle for this send until it resolves: tx hash on Kuru, client order identifier on Upbit. */
  ref: string | null;
  gasMon: number; // Kuru: gasLimit x gas price (Monad charges the limit). Upbit: 0
  cancel: OrderId[]; // resting order ids this send cancels
  status: "sent" | "placed" | "reverted" | "lost" | "sim";
  orderId: OrderId | null;
  /** The position cap or funds picked this side; the model's probabilities still show its call. */
  capped: boolean;
}

/** A maker fill: someone hit one of our resting orders. */
export interface Fill {
  side: Side;
  size: number; // MON
  price: number; // our order's price
  txHash: string | null; // Kuru: the taker's transaction
  orderId: OrderId;
  simulated: boolean;
  /** Exchange fee charged on this fill, in the quote currency. */
  fee: number;
}

export interface QuoteResult { block: number; quote: Quote; canceled: OrderId[] }

/** A public trade print. `side` is the TAKER (aggressor) side. */
export interface TradePrint { block: number; price: number; size: number; side: Side }

/** One of our resting orders got hit. `side` is OUR side (the maker's): a taker buy fills our ask, so side is "sell". */
export interface MakerFill { block: number; txHash: string | null; orderId: OrderId; price: number; size: number; updatedSize: number; side: Side; fee: number }

export interface TradeSummary {
  count: number;
  buyMon: number;
  sellMon: number;
  /** taker buy volume minus taker sell volume (MON) */
  cvdMon: number;
  vwap: number | null;
  lastPrice: number | null;
  lastSide: Side | null;
}

/** Recent prints and our maker fills. */
export interface TradeSource {
  /** Catch up to `block`. Never throws. Push-based sources can make this a no-op. */
  poll(block: number): Promise<void>;
  summary(lastBlocks: number, currentBlock: number): TradeSummary;
  /** Newest last. */
  recent(n: number): TradePrint[];
  /** Prints since the last call (oldest first). Used to simulate maker fills in a dry run. */
  drainPrints(): TradePrint[];
  /** Our maker fills since the last call (oldest first). */
  drainFills(): MakerFill[];
}

/** What the dashboard needs to label a venue. */
export interface VenueInfo {
  name: "kuru" | "upbit";
  /** Exchange name as shown. */
  label: string;
  /** Kuru: the OrderBook contract. Upbit: the market code, e.g. KRW-MON. */
  market: string;
  /** "MON-USDC", "MON-KRW": base first. */
  symbol: string;
  quoteCcy: string;
  /** Decimals to show prices with. */
  priceDecimals: number;
  /** What one step of the loop is called: "block" (Monad) or "tick" (a 300 ms timer). */
  clock: "block" | "tick";
  /** Explorer URL prefix for tx hashes, or null when there is no chain. */
  txUrl: string | null;
}

export interface Venue {
  readonly info: VenueInfo;
  /** Wallet address (Kuru) or account label (Upbit); null in a dry run. */
  readonly account: string | null;
  /** True when orders are signed and sent for real. */
  readonly live: boolean;
  /** Funds orders draw from, net of what is resting: Kuru margin account, Upbit available balance. */
  readonly funds: { mon: number; quote: number };
  /** Fee rate charged on a maker fill, for simulated fills. */
  readonly makerFeeRate: number;
  readonly trades: TradeSource;

  init(): Promise<void>;
  /** Calls `onBlock` once per new block (or tick), coalesced to the newest. */
  startClock(onBlock: (block: number) => void): void;
  /** Every `config.refreshBlocks`: balances and fee estimates. Never throws. */
  refresh(): Promise<void>;
  readBook(): Promise<Book>;
  /** Where an order on `side` rests: inside the touch by `quoteInsideTicks`, never crossing. */
  quotePrice(side: Side, book: Book): number;
  /** Cancel `cancel`, post one post-only limit order. Returns without waiting for confirmation. */
  send(block: number, side: Side, sizeMon: number, book: Book, cancel: OrderId[], capped: boolean): Promise<Quote>;
  /** Sends that resolved (or timed out) since the last call. */
  pollPending(block: number): Promise<QuoteResult[]>;
}

/** Summary of taker flow over the last `lastBlocks` blocks. Shared by every TradeSource. */
export function summarize(trades: TradePrint[], lastBlocks: number, currentBlock: number): TradeSummary {
  const minBlock = currentBlock - lastBlocks;
  let count = 0, buyMon = 0, sellMon = 0, notional = 0;
  let lastPrice: number | null = null, lastSide: Side | null = null;
  for (const t of trades) {
    if (t.block <= minBlock) continue;
    count++;
    if (t.side === "buy") buyMon += t.size; else sellMon += t.size;
    notional += t.size * t.price;
    lastPrice = t.price; lastSide = t.side;
  }
  const vol = buyMon + sellMon;
  return { count, buyMon, sellMon, cvdMon: buyMon - sellMon, vwap: vol > 0 ? notional / vol : null, lastPrice, lastSide };
}
