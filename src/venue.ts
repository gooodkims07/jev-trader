/**
 * The exchange boundary. The Trader, the model and the server only talk to a `Venue`; everything
 * specific to one exchange (Kuru spot on Monad, OKX perpetual swaps) lives behind it.
 *
 * Time is counted in "blocks": Monad blocks on Kuru, 300 ms clock ticks on OKX. Money fields named
 * `...Usd` elsewhere are in the venue's quote currency (`quoteCcy`: USDC on Kuru, USDT on OKX), and
 * size fields named `...Mon` are in the base asset (`base`: MON on Kuru, the swap's underlying on OKX;
 * OKX contracts are converted to it).
 */

export type Side = "buy" | "sell";

/** Kuru order ids are numbers; OKX order ids are strings. Negative numbers are simulated orders. */
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
  /** Cumulative base-asset depth within N bps of mid, per side. */
  depthBps: { [band: string]: { bid: number; ask: number } };
}

/**
 * This block's order: a post-only limit order resting on the book, replacing last block's.
 * `sent` until the venue confirms it, then `placed` (with its orderId) or `reverted` (it would have
 * crossed, or the venue rejected it). `lost` if no confirmation ever came.
 */
export interface Quote {
  side: Side;
  price: number; // quote currency per base unit, tick aligned
  size: number; // base asset
  /** Kuru: the transaction. OKX: always null (no chain). */
  txHash: string | null;
  /** The venue's handle for this send until it resolves: tx hash on Kuru, client order id on OKX. */
  ref: string | null;
  gasMon: number; // Kuru: gasLimit x gas price (Monad charges the limit). OKX: 0
  cancel: OrderId[]; // resting order ids this send cancels
  status: "sent" | "placed" | "reverted" | "lost" | "sim";
  orderId: OrderId | null;
  /** The position cap or funds picked this side; the model's probabilities still show its call. */
  capped: boolean;
  /** Set when a stop or take-profit forced this order: a reduce-only order closing the position. */
  close?: CloseReason;
}

/** Why the bot is closing its position. session-*: then it stops. position-*: then it trades on. */
export type CloseReason = "session-stop" | "session-take" | "position-stop" | "position-take";

/** A maker fill: someone hit one of our resting orders. */
export interface Fill {
  side: Side;
  size: number; // base asset
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
  /** taker buy volume minus taker sell volume (base asset) */
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
  name: "kuru" | "okx";
  /** Exchange name as shown. */
  label: string;
  /** Kuru: the OrderBook contract. OKX: the instrument id, e.g. MON-USDT-SWAP. */
  market: string;
  /** "MON-USDC", "MON-USDT": base first. */
  symbol: string;
  /** The asset traded: "MON", "BTC". Sizes are in this. */
  base: string;
  quoteCcy: string;
  /** Decimals to show prices with. */
  priceDecimals: number;
  /** Decimals to show sizes with: 1 for MON, more for assets where one unit is worth a lot. */
  sizeDecimals: number;
  /** What one step of the loop is called: "block" (Monad) or "tick" (a timer). */
  clock: "block" | "tick";
  /** Length of one step: ~300 ms Monad blocks, or OKX_TICK_MS. */
  blockMs: number;
  /** Explorer URL prefix for tx hashes, or null when there is no chain. */
  txUrl: string | null;
}

export interface Venue {
  readonly info: VenueInfo;
  /** Wallet address (Kuru) or account label (OKX); null in a dry run. */
  readonly account: string | null;
  /** True when orders are signed and sent for real. */
  readonly live: boolean;
  /**
   * Live only: would one more order of `size` on `side` fit the funds it draws on? Kuru spot needs quote
   * for a bid and MON for an ask; a perpetual needs margin either way. Balances refresh in `refresh()`.
   */
  canAfford(side: Side, size: number, book: Book): boolean;
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
  /**
   * Cancel `cancel`, post one post-only limit order. Returns without waiting for confirmation.
   * `reduceOnly`: the order may only shrink the position (OKX sends reduceOnly; Kuru spot ignores it).
   */
  send(block: number, side: Side, sizeMon: number, book: Book, cancel: OrderId[], capped: boolean, reduceOnly?: boolean): Promise<Quote>;
  /** Sends that resolved (or timed out) since the last call. */
  pollPending(block: number): Promise<QuoteResult[]>;
  /**
   * Live only, after fills change the position: keep any exchange-side protection in line with it (signed
   * size in the base asset, average entry). Optional; OKX places its emergency stop here.
   */
  protect?(position: { mon: number; entry: number | null }): void;
  /** On SIGINT/SIGTERM: take our orders off the book. Optional; Kuru leaves the last order resting as before. */
  shutdown?(): Promise<void>;
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

/** Book from levels sorted best first, with the same depth and imbalance rules as the Kuru book. For venues whose book arrives as plain levels. */
export function bookFromLevels(block: number, bids: [number, number][], asks: [number, number][]): Book {
  if (!bids.length || !asks.length) throw new Error(`empty book side at block ${block} (bids=${bids.length} asks=${asks.length})`);
  const bid = bids[0]![0], ask = asks[0]![0];
  const mid = (bid + ask) / 2;
  const near = (levels: [number, number][]) => levels.filter((l) => Math.abs(l[0] - mid) / mid < 0.01).reduce((s, l) => s + l[1], 0);
  const within = (levels: [number, number][], bps: number) => levels.filter((l) => (Math.abs(l[0] - mid) / mid) * 10_000 <= bps).reduce((s, l) => s + l[1], 0);
  const bidDepth = near(bids), askDepth = near(asks);
  const depthBps: Book["depthBps"] = {};
  for (const b of [10, 25, 50]) depthBps[String(b)] = { bid: within(bids, b), ask: within(asks, b) };
  return {
    block, bid, ask, mid,
    spreadBps: ((ask - bid) / mid) * 10_000,
    imbalance: bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0,
    levels: { bids: bids.slice(0, 5), asks: asks.slice(0, 5) },
    depthBps,
  };
}
