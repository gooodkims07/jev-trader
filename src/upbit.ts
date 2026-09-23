/**
 * An Upbit KRW market (UPBIT_MARKET, default KRW-MON; any KRW-<coin> works) as a Venue.
 *
 * There is no chain, so a timer stands in for the block: tick = floor(now / tickMs). Trade prints are
 * stamped with the tick of their exchange timestamp, so "the last 100 blocks" means the last 30 s.
 *
 * Market data comes from the public WebSocket (orderbook + trade), with REST as the fallback when the
 * socket is stale. Our fills come from the private myOrder stream; every cancel response also carries
 * the order's executed volume, so a fill the stream missed is still booked when that order is replaced.
 *
 * Each send cancels the previous order(s) with DELETE /v1/order, then posts one post-only limit order
 * with POST /v1/orders. Sequential, so funds locked by the old order are free for the new one. Nothing
 * in the hot loop waits for it: `send` returns `sent` and `pollPending` hands back the result.
 */
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { KRW_MIN_ORDER, UPBIT_WS, UPBIT_WS_PRIVATE, UpbitApi, UpbitError, krwTick, tickDecimals, type UpbitAccount, type UpbitOrder } from "./upbit-api";
import { summarize, type Book, type MakerFill, type OrderId, type Quote, type QuoteResult, type Side, type TradePrint, type TradeSource, type TradeSummary, type Venue, type VenueInfo } from "./venue";

const RING = 500;
const WARMUP_TRADES = 500;
/**
 * The socket only sends the book when it changes, so a quiet book is not a stale one. Trust it while
 * the socket has said anything (book, trade, or the reply to our PING) this recently; otherwise read
 * over REST. PING_MS keeps a quiet socket answering well inside that window.
 */
const SOCKET_QUIET_MS = 10_000;
const PING_MS = 3_000;
/** Our orders carry identifiers with this prefix, so the fill stream ignores orders placed by hand. */
const ID_PREFIX = "jev-";

interface WsOrderbookUnit { ask_price: number; bid_price: number; ask_size: number; bid_size: number }
interface WsOrderbook { type: "orderbook"; code: string; timestamp: number; orderbook_units: WsOrderbookUnit[] }
interface WsTrade { type: "trade"; code: string; trade_price: number; trade_volume: number; ask_bid: "ASK" | "BID"; trade_timestamp: number; sequential_id: number }
interface WsMyOrder {
  type: "myOrder"; code: string; uuid: string; ask_bid: "ASK" | "BID"; state: string; price: number;
  remaining_volume: number; executed_volume: number; trade_fee: number | null; trade_timestamp: number | null;
  identifier: string | null;
}
interface RestTrade { trade_price: number; trade_volume: number; ask_bid: "ASK" | "BID"; timestamp: number; sequential_id: number }

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Enough size decimals that the last digit is worth about 1 KRW or less: 2 for MON at ~35 KRW, 8 (Upbit's
 * limit) for BTC. Never fewer than 1.
 */
export const sizeDecimalsFor = (price: number) => Math.min(8, Math.max(1, Math.ceil(Math.log10(Math.max(price, 1)))));

/** Book from levels sorted best first, with the same depth and imbalance rules as the Kuru book. */
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

/** Prints (public trade stream) and our fills (private myOrder stream). */
class UpbitTrades implements TradeSource {
  private trades: TradePrint[] = [];
  private fresh: TradePrint[] = [];
  private fills: MakerFill[] = [];
  private seen = new Set<number>(); // sequential_id, so the snapshot a reconnect sends is not counted twice
  /** Executed volume already booked per order uuid, so a fill is counted once whichever path reports it. */
  private executed = new Map<string, number>();

  constructor(private readonly tickOf: (ms: number) => number) {}

  addPrint(seq: number, ts: number, price: number, size: number, askBid: "ASK" | "BID", fresh: boolean) {
    if (this.seen.has(seq) || size <= 0) return;
    this.seen.add(seq);
    if (this.seen.size > RING * 4) this.seen = new Set([...this.seen].slice(-RING * 2));
    // ask_bid is the aggressor: BID means a taker bought.
    const t: TradePrint = { block: this.tickOf(ts), price, size, side: askBid === "BID" ? "buy" : "sell" };
    this.trades.push(t);
    if (fresh) this.fresh.push(t);
    if (this.trades.length > RING) this.trades.splice(0, this.trades.length - RING);
  }

  /** Warm-up history arrives newest first; keep the ring ordered oldest first. */
  sortByTime() {
    this.trades.sort((a, b) => a.block - b.block);
  }

  /**
   * An order of ours has executed `total` (base asset) so far. Book the part not yet booked as one fill.
   * `fee` is Upbit's trade_fee when the stream reports it, else estimated at the configured rate.
   */
  recordExecuted(uuid: string, side: Side, price: number, total: number, remaining: number, ts: number, fee: number | null) {
    const before = this.executed.get(uuid) ?? 0;
    const size = round(total - before, 8);
    if (size <= 0) return;
    this.executed.set(uuid, total);
    if (this.executed.size > RING) this.executed.delete(this.executed.keys().next().value!);
    this.fills.push({
      block: this.tickOf(ts), txHash: null, orderId: uuid, price, size, updatedSize: remaining, side,
      fee: fee ?? size * price * config.upbit.feeRate,
    });
  }

  async poll() {}
  summary(lastBlocks: number, currentBlock: number): TradeSummary { return summarize(this.trades, lastBlocks, currentBlock); }
  recent(n: number) { return this.trades.slice(-n); }
  drainPrints() { const out = this.fresh; this.fresh = []; return out; }
  drainFills() { const out = this.fills; this.fills = []; return out; }
}

export class UpbitVenue implements Venue {
  readonly info: VenueInfo;
  readonly makerFeeRate = config.upbit.feeRate;
  readonly funds = { mon: 0, quote: 0 };
  readonly trades: UpbitTrades;
  private readonly api = new UpbitApi(config.upbit.accessKey, config.upbit.secretKey);
  private readonly market = config.upbit.market;
  private readonly base: string;
  private readonly quoteCcy: string;
  private wsBook: Book | null = null;
  private publicAt = 0; // last message on the public socket
  /** Sends that resolved since the last pollPending. */
  private done: QuoteResult[] = [];
  /** Side of every order we placed that may still rest, so a cancel response can be booked as fills. */
  private sides = new Map<string, Side>();

  constructor() {
    const [quote, base] = this.market.split("-");
    if (quote !== "KRW" || !base) throw new Error(`UPBIT_MARKET must be a KRW market like KRW-MON, got ${this.market}`);
    this.base = base;
    this.quoteCcy = quote;
    this.info = {
      name: "upbit", label: "Upbit", market: this.market, symbol: `${base}-${quote}`, base, quoteCcy: quote,
      priceDecimals: 1, sizeDecimals: 1, clock: "tick", txUrl: null,
    };
    this.trades = new UpbitTrades((ms) => this.tickOf(ms));
  }

  get live() { return !config.dryRun && this.api.authed; }
  get account() { return this.live ? `upbit ${this.market}` : null; }

  tickOf(ms: number) { return Math.floor(ms / config.upbit.tickMs); }

  async init() {
    if (this.base !== "MON" && !config.sizesSetForAnyCoin) throw new Error(`TRADE_SIZE_MON, MAX_POSITION_MON and the defaults are MON amounts. Set TRADE_SIZE and MAX_POSITION in ${this.base} for ${this.market}.`);
    const book = await this.restBook();
    this.info.priceDecimals = tickDecimals(krwTick(book.bid));
    this.info.sizeDecimals = sizeDecimalsFor(book.mid);
    const minSize = KRW_MIN_ORDER / book.bid;
    const notional = config.tradeSize * book.mid;
    if (config.tradeSize < minSize) throw new Error(`TRADE_SIZE ${config.tradeSize} ${this.base} is under Upbit's ${KRW_MIN_ORDER} KRW minimum (${minSize.toPrecision(3)} ${this.base} at ${book.bid} KRW)`);
    console.log(`upbit ${this.market} · ${config.tradeSize} ${this.base} per order ≈ ${Math.round(notional).toLocaleString("en-US")} KRW · price unit ${krwTick(book.bid)} KRW`);
    await this.warmupTrades();
    this.connectPublic();
    if (!this.live) return;
    await this.cancelOpenOrders();
    await this.refresh();
    this.connectPrivate();
    console.log(`upbit funds · ${this.funds.mon.toFixed(2)} ${this.base} · ${this.funds.quote.toFixed(0)} ${this.quoteCcy} available`);
  }

  /** A tick every `tickMs`, aligned to the wall clock. A late timer skips to the newest tick, never replays. */
  startClock(onBlock: (block: number) => void) {
    let last = this.tickOf(Date.now());
    setInterval(() => {
      const t = this.tickOf(Date.now());
      if (t > last) { last = t; onBlock(t); }
    }, Math.max(5, Math.floor(config.upbit.tickMs / 10)));
  }

  /** Available balances: Upbit already excludes what open orders have locked. */
  async refresh() {
    if (!this.live) return;
    try {
      const accounts = await this.api.exchange<UpbitAccount[]>("GET", "/v1/accounts");
      const bal = (c: string) => Number(accounts.find((a) => a.currency === c)?.balance ?? 0);
      this.funds.mon = bal(this.base);
      this.funds.quote = bal(this.quoteCcy);
    } catch (e) {
      console.warn(`upbit accounts: ${(e as Error).message}`);
    }
  }

  async readBook(): Promise<Book> {
    const now = Date.now();
    if (this.wsBook && now - this.publicAt < SOCKET_QUIET_MS) return { ...this.wsBook, block: this.tickOf(now) };
    return this.restBook();
  }

  /**
   * `quoteInsideTicks` inside the touch on our side, never crossing; join the touch when the spread is
   * too tight. The price unit depends on the price range, so step with the unit of the price we land on.
   */
  quotePrice(side: Side, book: Book): number {
    let p = side === "buy" ? book.bid : book.ask;
    for (let i = 0; i < config.quoteInsideTicks; i++) p = side === "buy" ? p + krwTick(p) : p - krwTick(p * (1 - 1e-9));
    const snapped = this.snap(p);
    if (side === "buy" && snapped >= book.ask) return book.bid;
    if (side === "sell" && snapped <= book.bid) return book.ask;
    return snapped;
  }

  async send(block: number, side: Side, sizeMon: number, book: Book, cancel: OrderId[], capped: boolean): Promise<Quote> {
    const price = this.quotePrice(side, book);
    if (!this.live) return { side, price, size: sizeMon, txHash: null, ref: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
    const ref = ID_PREFIX + randomUUID();
    const quote: Quote = { side, price, size: sizeMon, txHash: null, ref, gasMon: 0, cancel, status: "sent", orderId: null, capped };
    this.replace(block, quote).then((r) => this.done.push(r));
    return quote;
  }

  async pollPending(): Promise<QuoteResult[]> {
    const out = this.done; this.done = []; return out;
  }

  /** Cancel what rests, then post the new order. Always resolves. */
  private async replace(block: number, quote: Quote): Promise<QuoteResult> {
    const canceled: OrderId[] = [];
    await Promise.all(quote.cancel.map(async (id) => {
      const uuid = String(id);
      try {
        const o = await this.api.exchange<UpbitOrder>("DELETE", "/v1/order", { uuid });
        this.bookExecuted(o);
        canceled.push(id);
        this.sides.delete(uuid);
      } catch (e) {
        // Rate limited or unreachable: it still rests, so the next block cancels it again.
        // Any other refusal (already filled or already cancelled): it is off the book.
        if (e instanceof UpbitError && e.transient) console.warn(`upbit cancel ${uuid}: ${e.message}`);
        else { canceled.push(id); this.sides.delete(uuid); }
      }
    }));
    const px = this.snap(quote.price).toFixed(tickDecimals(krwTick(quote.price)));
    try {
      const o = await this.api.exchange<UpbitOrder>("POST", "/v1/orders", {
        market: this.market, side: quote.side === "buy" ? "bid" : "ask", volume: String(quote.size), price: px,
        ord_type: "limit", time_in_force: "post_only", identifier: quote.ref!,
      });
      // A post-only order that would have crossed comes back already cancelled.
      if (o.state === "cancel") return { block, quote: { ...quote, status: "reverted" }, canceled };
      this.sides.set(o.uuid, quote.side);
      if (this.sides.size > 100) this.sides.delete(this.sides.keys().next().value!);
      return { block, quote: { ...quote, status: "placed", orderId: o.uuid }, canceled };
    } catch (e) {
      const err = e instanceof UpbitError ? e : new UpbitError(0, "error", (e as Error).message);
      console.warn(`upbit order: ${err.message}`);
      return { block, quote: { ...quote, status: err.transient ? "lost" : "reverted" }, canceled };
    }
  }

  /** A cancel response carries the order's executed volume at cancel time: book anything the stream missed. */
  private bookExecuted(o: UpbitOrder) {
    const side = this.sides.get(o.uuid) ?? (o.side === "bid" ? "buy" : "sell");
    this.trades.recordExecuted(o.uuid, side, Number(o.price), Number(o.executed_volume), Number(o.remaining_volume ?? 0), Date.now(), null);
  }

  private snap(price: number) {
    const tick = krwTick(price);
    return round(Math.round(price / tick) * tick, tickDecimals(tick));
  }

  private async restBook(): Promise<Book> {
    const [ob] = await this.api.quote<WsOrderbook[]>("/v1/orderbook", { markets: this.market });
    if (!ob) throw new Error(`upbit orderbook: no data for ${this.market}`);
    return this.toBook(ob.orderbook_units, Date.now());
  }

  private toBook(units: WsOrderbookUnit[], ms: number): Book {
    const bids = units.filter((u) => u.bid_size > 0).map((u): [number, number] => [u.bid_price, u.bid_size]);
    const asks = units.filter((u) => u.ask_size > 0).map((u): [number, number] => [u.ask_price, u.ask_size]);
    return bookFromLevels(this.tickOf(ms), bids, asks);
  }

  private async warmupTrades() {
    try {
      const ticks = await this.api.quote<RestTrade[]>("/v1/trades/ticks", { market: this.market, count: String(WARMUP_TRADES) });
      for (const t of ticks) this.trades.addPrint(t.sequential_id, t.timestamp, t.trade_price, t.trade_volume, t.ask_bid, false);
      this.trades.sortByTime();
    } catch (e) {
      console.warn(`upbit trade warm-up: ${(e as Error).message}`);
    }
  }

  /** Cancel whatever of ours is open on this market from an earlier run, so the cap starts from a clean book. */
  private async cancelOpenOrders() {
    const open = await this.api.exchange<UpbitOrder[]>("GET", "/v1/orders/open", { market: this.market, limit: "100" });
    const ours = open.filter((o) => o.identifier?.startsWith(ID_PREFIX));
    for (const o of ours) await this.api.exchange("DELETE", "/v1/order", { uuid: o.uuid }).catch(() => {});
    if (ours.length) console.log(`upbit: cancelled ${ours.length} open order(s) left from an earlier run`);
  }

  private connectPublic() {
    this.socket(UPBIT_WS, () => ({}), () => { this.wsBook = null; }, [
      { ticket: `jev-${randomUUID()}` },
      { type: "orderbook", codes: [this.market] },
      { type: "trade", codes: [this.market] },
      { format: "DEFAULT" },
    ], (m) => {
      this.publicAt = Date.now();
      if (m.type === "orderbook") {
        const ob = m as WsOrderbook;
        try { this.wsBook = this.toBook(ob.orderbook_units, ob.timestamp); } catch {}
      } else if (m.type === "trade") {
        const t = m as WsTrade;
        this.trades.addPrint(t.sequential_id, t.trade_timestamp, t.trade_price, t.trade_volume, t.ask_bid, true);
      }
    });
  }

  private connectPrivate() {
    this.socket(UPBIT_WS_PRIVATE, () => ({ authorization: this.api.auth() }), () => {}, [
      { ticket: `jev-${randomUUID()}` },
      { type: "myOrder", codes: [this.market] },
      { format: "DEFAULT" },
    ], (m) => {
      if (m.type !== "myOrder") return;
      const o = m as WsMyOrder;
      if (!o.identifier?.startsWith(ID_PREFIX)) return;
      if (o.state !== "trade" && o.state !== "done") return;
      this.trades.recordExecuted(o.uuid, o.ask_bid === "BID" ? "buy" : "sell", o.price, o.executed_volume, o.remaining_volume, o.trade_timestamp ?? Date.now(), o.trade_fee);
    });
  }

  /**
   * One WebSocket, reconnected with backoff. Upbit sends binary frames and drops sockets idle for 120 s.
   * The PING reply ({"status":"UP"}) is passed on like any message, so it counts as the socket being alive.
   */
  private socket(url: string, headers: () => Record<string, string>, onClose: () => void, subscribe: unknown[], onMessage: (m: { type?: string }) => void) {
    const decoder = new TextDecoder();
    const connect = (delay = 0) =>
      setTimeout(() => {
        const ws = new WebSocket(url, { headers: headers() } as any);
        ws.binaryType = "arraybuffer";
        let ping: ReturnType<typeof setInterval> | undefined;
        ws.onopen = () => {
          delay = 0;
          ws.send(JSON.stringify(subscribe));
          ping = setInterval(() => { try { ws.send("PING"); } catch {} }, PING_MS);
        };
        ws.onmessage = (e) => {
          const text = typeof e.data === "string" ? e.data : decoder.decode(e.data as ArrayBuffer);
          let m: { type?: string; status?: string };
          try { m = JSON.parse(text); } catch { return; }
          onMessage(m);
        };
        ws.onclose = () => { clearInterval(ping); onClose(); connect(Math.min(delay + 1000, 10_000)); };
        ws.onerror = () => ws.close();
      }, delay);
    connect();
  }
}
