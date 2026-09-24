/**
 * An OKX USDT-margined perpetual swap (OKX_INST_ID, default XRP-USDT-SWAP) as a Venue.
 *
 * No chain, so a timer stands in for the block: tick = floor(now / tickMs), and trade prints are
 * stamped with the tick of their exchange timestamp. OKX sizes are contracts (ctVal of the
 * underlying each); everything that leaves this file is in the underlying, so the Trader, the model
 * and the dashboard see XRP (or whatever the swap trades), not contracts.
 *
 * Market data: public WebSocket `books5` and `trades`, with REST as the fallback when the socket is
 * quiet. Our fills: private WebSocket `orders` (fillSz, fillPx, fillFee per update). Each send cancels
 * what rests, then posts one post-only limit order; nothing in the hot loop waits for either.
 *
 * Futures specifics: the account must be in net position mode (one signed position per swap, which is
 * what the Trader tracks); leverage and margin mode are set for the instrument at startup; both sides
 * draw margin; a live run refuses to start with a position already open; funding is not in the P&L.
 */
import { config } from "./config";
import { OkxApi, OkxError, newClOrdId, okxWs, stepDecimals } from "./okx-api";
import { bookFromLevels, summarize, type Book, type MakerFill, type OrderId, type Quote, type QuoteResult, type Side, type TradePrint, type TradeSource, type TradeSummary, type Venue, type VenueInfo } from "./venue";

const RING = 500;
const WARMUP_TRADES = 500;
/** books5 pushes only on change; trust the cached book while the socket has said anything this recently. */
const SOCKET_QUIET_MS = 10_000;
/** OKX drops a socket after 30 s of silence; "ping" keeps a quiet one alive and counts as liveness. */
const PING_MS = 5_000;
const CL_PREFIX = "jev";
const STOP_PREFIX = "jevsl";
/** Stop after this many refused orders in a row. */
const MAX_REJECTS = 20;

interface Instrument { instId: string; ctVal: string; ctValCcy: string; lotSz: string; minSz: string; tickSz: string; settleCcy: string; state: string }
/** [price, size in contracts, deprecated "0", number of orders] */
type Level4 = string[];
interface BookMsg { asks: Level4[]; bids: Level4[]; ts: string }
interface TradeMsg { tradeId: string; px: string; sz: string; side: "buy" | "sell"; ts: string }
interface OrderMsg {
  ordId: string; clOrdId: string; side: Side; state: string; px: string; sz: string; accFillSz: string;
  fillSz: string; fillPx: string; fillFee: string; fillTime: string; tradeId: string;
}
interface PlaceResult { ordId: string; clOrdId: string; sCode: string; sMsg: string }

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Prints (public `trades`) and our fills (private `orders`), all in the underlying. */
class OkxTrades implements TradeSource {
  private trades: TradePrint[] = [];
  private fresh: TradePrint[] = [];
  private fills: MakerFill[] = [];
  private seenTrades = new Set<string>();
  private seenFills = new Set<string>();

  constructor(private readonly tickOf: (ms: number) => number) {}

  addPrint(tradeId: string, ts: number, price: number, size: number, taker: Side, fresh: boolean) {
    if (this.seenTrades.has(tradeId) || size <= 0) return;
    this.seenTrades.add(tradeId);
    if (this.seenTrades.size > RING * 4) this.seenTrades = new Set([...this.seenTrades].slice(-RING * 2));
    const t: TradePrint = { block: this.tickOf(ts), price, size, side: taker };
    this.trades.push(t);
    if (fresh) this.fresh.push(t);
    if (this.trades.length > RING) this.trades.splice(0, this.trades.length - RING);
  }

  sortByTime() { this.trades.sort((a, b) => a.block - b.block); }

  /** One execution of ours. `fee` is the cost (OKX's fillFee is negative when charged, positive on a rebate). */
  addFill(tradeId: string, f: MakerFill) {
    if (this.seenFills.has(tradeId)) return;
    this.seenFills.add(tradeId);
    if (this.seenFills.size > RING * 4) this.seenFills = new Set([...this.seenFills].slice(-RING * 2));
    this.fills.push(f);
  }

  async poll() {}
  summary(lastBlocks: number, currentBlock: number): TradeSummary { return summarize(this.trades, lastBlocks, currentBlock); }
  recent(n: number) { return this.trades.slice(-n); }
  drainPrints() { const out = this.fresh; this.fresh = []; return out; }
  drainFills() { const out = this.fills; this.fills = []; return out; }
}

export class OkxVenue implements Venue {
  readonly info: VenueInfo;
  readonly trades: OkxTrades;
  makerFeeRate = config.okx.makerFeeRate;
  /**
   * Demo trading has its own markets and books, so a live demo run reads them too. A dry run sends
   * nothing and always reads the real market, whatever OKX_DEMO says.
   */
  private readonly demo = config.okx.demo && !config.dryRun && !!(config.okx.apiKey && config.okx.secretKey && config.okx.passphrase);
  private readonly api = new OkxApi(config.okx.apiKey, config.okx.secretKey, config.okx.passphrase, this.demo);
  private readonly instId = config.okx.instId;
  private readonly base: string;
  private ctVal = 1;
  private lotSz = 1;
  private tick = 0;
  private tickDec = 0;
  private wsBook: Book | null = null;
  private publicAt = 0;
  private privateUp = false;
  /** USDT available for new margin, and our signed position in contracts, as of the last refresh. */
  private availUsdt = 0;
  private posContracts = 0;
  private done: QuoteResult[] = [];
  private fundingRatePct: number | null = null;
  /** Orders OKX refused in a row (not rate limits or outages). */
  private rejectStreak = 0;
  /** Our exchange-side emergency stop, as last placed; `wanted` is the position it should cover. */
  private stop: { algoId: string; side: Side; trigger: number } | null = null;
  private wanted: { mon: number; entry: number | null } = { mon: 0, entry: null };
  private syncing = false;
  private stopWarnedAt = 0;
  private halted = false;

  constructor() {
    const [base, quote, kind] = this.instId.split("-");
    if (!base || quote !== "USDT" || kind !== "SWAP") throw new Error(`OKX_INST_ID must be a USDT perpetual like XRP-USDT-SWAP, got ${this.instId}`);
    this.base = base;
    this.info = {
      name: "okx", label: "OKX", market: this.instId, symbol: `${base}-USDT PERP`, base, quoteCcy: "USDT",
      priceDecimals: 5, sizeDecimals: 0, clock: "tick", blockMs: config.okx.tickMs, txUrl: null,
    };
    this.trades = new OkxTrades((ms) => this.tickOf(ms));
  }

  get live() { return !config.dryRun && this.api.authed; }
  get account() { return this.live ? `okx ${this.instId}${this.demo ? " demo" : ""}` : null; }

  tickOf(ms: number) { return Math.floor(ms / config.okx.tickMs); }

  async init() {
    if (this.base !== "MON" && !config.sizesSetForAnyCoin) throw new Error(`TRADE_SIZE_MON, MAX_POSITION_MON and the defaults are MON amounts. Set TRADE_SIZE and MAX_POSITION in ${this.base} for ${this.instId}.`);
    await this.api.syncTime();
    const inst = await this.api.public<Instrument[]>("/api/v5/public/instruments", { instType: "SWAP", instId: this.instId })
      .then(([i]) => i)
      .catch((e: OkxError) => {
        if (e.code === "51001" && this.demo) throw new Error(`okx: ${this.instId} is not listed on OKX demo trading. Pick a swap that is (e.g. OKX_INST_ID=BTC-USDT-SWAP with TRADE_SIZE and MAX_POSITION in BTC), or trade it for real with OKX_DEMO=false.`);
        throw e;
      });
    if (!inst) throw new Error(`okx: no instrument ${this.instId}`);
    if (inst.state !== "live") throw new Error(`okx: ${this.instId} is ${inst.state}, not live`);
    if (inst.ctValCcy !== this.base) throw new Error(`okx: ${this.instId} contracts are in ${inst.ctValCcy}, expected ${this.base}`);
    this.ctVal = Number(inst.ctVal);
    this.lotSz = Number(inst.lotSz);
    this.tick = Number(inst.tickSz);
    this.tickDec = stepDecimals(inst.tickSz);
    this.info.priceDecimals = this.tickDec;
    this.info.sizeDecimals = stepDecimals(String(this.ctVal * this.lotSz));

    const step = this.ctVal * this.lotSz;
    const contracts = config.tradeSize / this.ctVal;
    if (Math.abs(contracts / this.lotSz - Math.round(contracts / this.lotSz)) > 1e-9 || contracts < Number(inst.minSz))
      throw new Error(`TRADE_SIZE ${config.tradeSize} ${this.base} must be a multiple of ${step} ${this.base} (one lot of ${this.lotSz} contract(s) x ${this.ctVal}) and at least ${Number(inst.minSz) * this.ctVal}`);

    await this.warmupTrades();
    await this.readFunding();
    this.connectPublic();
    const book = await this.restBook();
    console.log(`okx ${this.instId}${this.demo ? " (demo)" : ""} · ${config.tradeSize} ${this.base} = ${contracts} contracts per order ≈ ${(config.tradeSize * book.mid).toFixed(2)} USDT · tick ${inst.tickSz}`);
    if (!this.live) return;

    const [cfg] = await this.api.signed<{ posMode: string; acctLv: string }[]>("GET", "/api/v5/account/config");
    if (cfg?.posMode !== "net_mode") throw new Error(`okx: account is in ${cfg?.posMode}; the bot needs net_mode (one signed position per swap). Switch it in OKX settings.`);
    await this.api.signed("POST", "/api/v5/account/set-leverage", { instId: this.instId, lever: String(config.okx.leverage), mgnMode: config.okx.marginMode })
      .catch((e: OkxError) => { throw new Error(`okx set-leverage ${config.okx.leverage}x ${config.okx.marginMode}: ${e.message}. Try OKX_MARGIN_MODE=cross if isolated is not allowed for this account.`); });
    await this.readFee();
    await this.cancelLeftovers();
    await this.cancelLeftoverStops();
    await this.refresh();
    if (this.posContracts !== 0) throw new Error(`okx: ${this.instId} already has a position of ${this.posContracts * this.ctVal} ${this.base}. Close it first: the bot's cap and P&L start from flat.`);
    this.connectPrivate();
    console.log(`okx account · ${this.availUsdt.toFixed(2)} USDT available · ${config.okx.leverage}x ${config.okx.marginMode} · maker fee ${(this.makerFeeRate * 100).toFixed(4)}%`);
  }

  startClock(onBlock: (block: number) => void) {
    let last = this.tickOf(Date.now());
    setInterval(() => {
      const t = this.tickOf(Date.now());
      if (t > last) { last = t; onBlock(t); }
    }, Math.max(5, Math.floor(config.okx.tickMs / 10)));
  }

  /** Funding rate (dry runs too); live: USDT available for margin, and our position (so the reducing side is never blocked for funds). */
  async refresh() {
    await this.readFunding();
    if (!this.live) return;
    const [bal, pos] = await Promise.allSettled([
      this.api.signed<{ details: { ccy: string; availBal: string; availEq: string }[] }[]>("GET", "/api/v5/account/balance", { ccy: "USDT" }),
      this.api.signed<{ instId: string; pos: string }[]>("GET", "/api/v5/account/positions", { instId: this.instId }),
    ]);
    if (bal.status === "fulfilled") {
      const d = bal.value[0]?.details.find((x) => x.ccy === "USDT");
      this.availUsdt = Number(d?.availBal || d?.availEq || 0);
    } else console.warn(`okx balance: ${(bal.reason as Error).message}`);
    if (pos.status === "fulfilled") this.posContracts = pos.value.filter((p) => p.instId === this.instId).reduce((s, p) => s + Number(p.pos || 0), 0);
    else console.warn(`okx positions: ${(pos.reason as Error).message}`);
    // OKX drops the stop when the position closes, and a race may have left none: check it is still there.
    if (this.stop && config.okx.emergencyStopPct > 0) {
      const live = await this.api.signed<{ algoId: string }[]>("GET", "/api/v5/trade/orders-algo-pending", { ordType: "conditional", instType: "SWAP", instId: this.instId }).catch(() => null);
      if (live && !live.some((o) => o.algoId === this.stop!.algoId)) this.stop = null;
    }
    if (config.okx.emergencyStopPct > 0 && !this.syncing) this.syncStop();
  }

  /** Reducing the position needs no new margin; adding needs notional / leverage, plus a fee's worth of headroom. */
  canAfford(side: Side, size: number, book: Book) {
    const reduces = side === "buy" ? this.posContracts < 0 : this.posContracts > 0;
    if (reduces && size / this.ctVal <= Math.abs(this.posContracts)) return true;
    const price = side === "buy" ? book.bid : book.ask;
    return this.availUsdt >= (size * price) / config.okx.leverage * 1.01;
  }

  async readBook(): Promise<Book> {
    const now = Date.now();
    if (this.wsBook && now - this.publicAt < SOCKET_QUIET_MS) return { ...this.wsBook, block: this.tickOf(now) };
    return this.restBook();
  }

  /** `quoteInsideTicks` inside the touch on our side, never crossing; join the touch when the spread is too tight. */
  quotePrice(side: Side, book: Book): number {
    const u = (p: number) => Math.round(p / this.tick);
    const bidU = u(book.bid), askU = u(book.ask), step = config.quoteInsideTicks;
    let p = side === "buy" ? bidU + step : askU - step;
    if (side === "buy" && p >= askU) p = bidU;
    if (side === "sell" && p <= bidU) p = askU;
    return round(p * this.tick, this.tickDec);
  }

  async send(block: number, side: Side, sizeMon: number, book: Book, cancel: OrderId[], capped: boolean, reduceOnly = false): Promise<Quote> {
    const price = this.quotePrice(side, book);
    if (!this.live) return { side, price, size: sizeMon, txHash: null, ref: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
    if (this.halted) throw new Error("okx: halted after repeated order rejections");
    const ref = newClOrdId();
    const quote: Quote = { side, price, size: sizeMon, txHash: null, ref, gasMon: 0, cancel, status: "sent", orderId: null, capped };
    this.replace(block, quote, reduceOnly).then((r) => this.done.push(r));
    return quote;
  }

  async pollPending(): Promise<QuoteResult[]> {
    const out = this.done; this.done = []; return out;
  }

  /**
   * Cancel whatever of ours is still open on this swap, e.g. on shutdown. The position is left as it is,
   * and so is the emergency stop covering it (OKX drops that once the position closes).
   */
  async shutdown() {
    if (!this.live) return;
    await this.cancelLeftovers().catch((e) => console.warn(`okx cancel on shutdown: ${(e as Error).message}`));
    await this.refresh().catch(() => {});
    if (this.posContracts !== 0) {
      const stop = this.stop ? ` The emergency stop stays on OKX: ${this.stop.side} at mark ${this.stop.trigger}.` : "";
      console.warn(`okx: position left open: ${this.posContracts * this.ctVal} ${this.base} on ${this.instId}. Close it on OKX if you do not want to hold it.${stop}`);
    }
  }

  /** Keep the emergency stop covering the position the Trader now holds. Coalesces bursts; never throws. */
  protect(position: { mon: number; entry: number | null }) {
    if (!this.live || !(config.okx.emergencyStopPct > 0)) return;
    this.wanted = position;
    if (!this.syncing) this.syncStop();
  }

  /** Where the emergency stop for this position should sit, or null when flat. */
  stopFor(p: { mon: number; entry: number | null }): { side: Side; trigger: number } | null {
    if (p.mon === 0 || !p.entry) return null;
    const pct = config.okx.emergencyStopPct / 100;
    const long = p.mon > 0;
    const px = p.entry * (long ? 1 - pct : 1 + pct);
    return { side: long ? "sell" : "buy", trigger: round(Math.round(px / this.tick) * this.tick, this.tickDec) };
  }

  /**
   * Cancel the stop if the position went flat, flipped, or its entry moved it by more than 0.5% of price,
   * then place one for the current position: conditional, closeFraction 1 (the whole position), reduce-only,
   * market on trigger, triggered by the mark price, dropped by OKX when the position closes.
   */
  private async syncStop() {
    this.syncing = true;
    try {
      for (let pass = 0; pass < 3; pass++) {
        const target = this.stopFor(this.wanted);
        const cur = this.stop;
        const moved = cur && target && Math.abs(cur.trigger - target.trigger) / target.trigger > 0.005;
        if (cur && (!target || cur.side !== target.side || moved)) {
          await this.api.signed("POST", "/api/v5/trade/cancel-algos", [{ algoId: cur.algoId, instId: this.instId }]).catch(() => {}); // gone already is fine
          this.stop = null;
        }
        if (target && !this.stop) {
          const [r] = await this.api.signed<{ algoId: string }[]>("POST", "/api/v5/trade/order-algo", {
            instId: this.instId, tdMode: config.okx.marginMode, side: target.side, posSide: "net", ordType: "conditional",
            closeFraction: "1", reduceOnly: true, cxlOnClosePos: true,
            slTriggerPx: target.trigger.toFixed(this.tickDec), slOrdPx: "-1", slTriggerPxType: "mark",
            algoClOrdId: newClOrdId(STOP_PREFIX),
          });
          this.stop = { algoId: r!.algoId, ...target };
          console.log(`okx emergency stop: ${target.side} the whole position at mark ${target.trigger}`);
        }
        // Done unless the position changed again while we were talking to OKX.
        const again = this.stopFor(this.wanted);
        if ((again?.side ?? null) === (this.stop?.side ?? null) && (!again || !this.stop || Math.abs(again.trigger - this.stop.trigger) / again.trigger <= 0.005)) break;
      }
    } catch (e) {
      // Usually a race with the position (it flipped or closed under us): the next fill resyncs. Warn at most once a minute.
      if (Date.now() - this.stopWarnedAt > 60_000) { this.stopWarnedAt = Date.now(); console.warn(`okx emergency stop: ${(e as Error).message}`); }
    } finally {
      this.syncing = false;
    }
  }

  /** Our emergency stops left from an earlier run. Startup refuses an open position, so any found are stale. */
  private async cancelLeftoverStops() {
    const open = await this.api.signed<{ algoId: string; algoClOrdId: string }[]>("GET", "/api/v5/trade/orders-algo-pending", { ordType: "conditional", instType: "SWAP", instId: this.instId }).catch(() => []);
    const ours = open.filter((o) => o.algoClOrdId?.startsWith(STOP_PREFIX));
    if (ours.length) {
      await this.api.signed("POST", "/api/v5/trade/cancel-algos", ours.map((o) => ({ algoId: o.algoId, instId: this.instId }))).catch(() => {});
      console.log(`okx: cancelled ${ours.length} emergency stop(s) left from an earlier run`);
    }
  }

  /** Cancel what rests, then post. Sequential so the margin the old order held is free for the new one. Always resolves. */
  private async replace(block: number, quote: Quote, reduceOnly: boolean): Promise<QuoteResult> {
    const canceled: OrderId[] = [];
    await Promise.all(quote.cancel.map(async (id) => {
      try {
        await this.api.signed("POST", "/api/v5/trade/cancel-order", { instId: this.instId, ordId: String(id) });
        canceled.push(id);
      } catch (e) {
        // 51400/51410/51603: already filled, cancelling, or gone. Rate limited or unreachable: it still rests, retry next block.
        if (e instanceof OkxError && e.transient) console.warn(`okx cancel ${id}: ${e.message}`);
        else canceled.push(id);
      }
    }));
    try {
      const [r] = await this.api.signed<PlaceResult[]>("POST", "/api/v5/trade/order", {
        instId: this.instId, tdMode: config.okx.marginMode, side: quote.side, ordType: "post_only",
        px: quote.price.toFixed(this.tickDec), sz: String(round(quote.size / this.ctVal, 8)), clOrdId: quote.ref!,
        ...(reduceOnly ? { reduceOnly: true } : {}),
      });
      // A post-only order that would cross is accepted, then cancelled by OKX (cancelSource 31). It shows
      // as placed here; the next block's cancel finds it gone (51400) and drops it.
      this.rejectStreak = 0;
      return { block, quote: { ...quote, status: "placed", orderId: r!.ordId }, canceled };
    } catch (e) {
      const err = e instanceof OkxError ? e : new OkxError(0, "error", (e as Error).message);
      console.warn(`okx order: ${err.message}`);
      if (!err.transient) this.rejectFailure(err);
      return { block, quote: { ...quote, status: err.transient ? "lost" : "reverted" }, canceled };
    }
  }

  /**
   * Stop instead of sending the same refused order every tick: at once on an auth or permission refusal
   * (HTTP 401, codes 501xx), otherwise after MAX_REJECTS in a row. SIGINT runs the normal shutdown, which
   * cancels our orders and reports any position.
   */
  private rejectFailure(err: OkxError) {
    this.rejectStreak++;
    const fatal = err.status === 401 || err.code.startsWith("501");
    if (this.halted || (!fatal && this.rejectStreak < MAX_REJECTS)) return;
    this.halted = true;
    console.error(`okx: stopping. ${fatal ? "OKX refused the key for trading" : `${this.rejectStreak} orders refused in a row`}: ${err.message}`);
    process.kill(process.pid, "SIGINT");
  }

  extras() { return { fundingRatePct: this.fundingRatePct }; }

  /** The swap's current funding rate, in percent per period. Never throws. */
  private async readFunding() {
    try {
      const [f] = await this.api.public<{ fundingRate: string }[]>("/api/v5/public/funding-rate", { instId: this.instId });
      if (f) this.fundingRatePct = round(Number(f.fundingRate) * 100, 5);
    } catch {}
  }

  /** Take these orders off the book (the model skipped). Resolves to the ids that are gone. */
  async cancel(ids: OrderId[]): Promise<OrderId[]> {
    if (!this.live) return ids;
    const gone: OrderId[] = [];
    await Promise.all(ids.map(async (id) => {
      try {
        await this.api.signed("POST", "/api/v5/trade/cancel-order", { instId: this.instId, ordId: String(id) });
        gone.push(id);
      } catch (e) {
        if (!(e instanceof OkxError && e.transient)) gone.push(id); // already filled, cancelling, or gone
      }
    }));
    return gone;
  }

  private async readFee() {
    try {
      const [f] = await this.api.signed<{ maker: string }[]>("GET", "/api/v5/account/trade-fee", { instType: "SWAP", instFamily: this.instId.replace(/-SWAP$/, "") });
      // OKX: negative = commission charged, positive = rebate. Ours: the cost.
      if (f?.maker) this.makerFeeRate = -Number(f.maker);
    } catch (e) {
      console.warn(`okx trade-fee: ${(e as Error).message}; using ${config.okx.makerFeeRate}`);
    }
  }

  /** Cancel our open orders on this swap (clOrdId starting "jev"), e.g. left by an earlier run. */
  private async cancelLeftovers() {
    const open = await this.api.signed<{ ordId: string; clOrdId: string }[]>("GET", "/api/v5/trade/orders-pending", { instType: "SWAP", instId: this.instId });
    const ours = open.filter((o) => o.clOrdId?.startsWith(CL_PREFIX));
    for (const o of ours) await this.api.signed("POST", "/api/v5/trade/cancel-order", { instId: this.instId, ordId: o.ordId }).catch(() => {});
    if (ours.length) console.log(`okx: cancelled ${ours.length} open order(s) of ours`);
  }

  private toBook(msg: BookMsg, ms: number): Book {
    const lv = (l: Level4): [number, number] => [Number(l[0]), Number(l[1]) * this.ctVal];
    return bookFromLevels(this.tickOf(ms), msg.bids.map(lv), msg.asks.map(lv));
  }

  private async restBook(): Promise<Book> {
    const [b] = await this.api.public<BookMsg[]>("/api/v5/market/books", { instId: this.instId, sz: "20" });
    if (!b) throw new Error(`okx books: no data for ${this.instId}`);
    return this.toBook(b, Date.now());
  }

  private async warmupTrades() {
    try {
      const ts = await this.api.public<TradeMsg[]>("/api/v5/market/trades", { instId: this.instId, limit: String(WARMUP_TRADES) });
      for (const t of ts) this.trades.addPrint(t.tradeId, Number(t.ts), Number(t.px), Number(t.sz) * this.ctVal, t.side, false);
      this.trades.sortByTime();
    } catch (e) {
      console.warn(`okx trade warm-up: ${(e as Error).message}`);
    }
  }

  private connectPublic() {
    this.socket("public", () => {}, [{ channel: "books5", instId: this.instId }, { channel: "trades", instId: this.instId }], (channel, data) => {
      if (channel === "books5") {
        const b = data[0] as BookMsg | undefined;
        if (b) try { this.wsBook = this.toBook(b, Number(b.ts)); } catch {}
      } else if (channel === "trades") {
        for (const t of data as TradeMsg[]) this.trades.addPrint(t.tradeId, Number(t.ts), Number(t.px), Number(t.sz) * this.ctVal, t.side, true);
      }
    }, () => { this.publicAt = Date.now(); }, () => { this.wsBook = null; });
  }

  private connectPrivate() {
    this.socket("private", (ws) => ws.send(JSON.stringify({ op: "login", args: [this.api.wsLogin()] })),
      [{ channel: "orders", instType: "SWAP", instId: this.instId }],
      (channel, data) => {
        if (channel !== "orders") return;
        for (const o of data as OrderMsg[]) {
          if (!o.clOrdId?.startsWith(CL_PREFIX) || !(Number(o.fillSz) > 0) || !o.tradeId) continue;
          this.trades.addFill(o.tradeId, {
            block: this.tickOf(Number(o.fillTime) || Date.now()), txHash: null, orderId: o.ordId,
            price: Number(o.fillPx), size: Number(o.fillSz) * this.ctVal,
            updatedSize: Math.max(0, Number(o.sz) - Number(o.accFillSz)) * this.ctVal,
            side: o.side, fee: -Number(o.fillFee || 0),
          });
        }
      }, () => {}, () => {
        if (this.privateUp) console.warn("okx: private socket dropped; fills are missed until it reconnects");
        this.privateUp = false;
      }, () => { this.privateUp = true; });
  }

  /**
   * One WebSocket, reconnected with backoff. Private sockets log in first and subscribe once the login
   * is acknowledged. "pong" and every other message count as liveness.
   */
  private socket(
    kind: "public" | "private",
    onOpen: (ws: WebSocket) => void,
    args: object[],
    onData: (channel: string, data: unknown[]) => void,
    onAlive: () => void,
    onClose: () => void,
    onReady: () => void = () => {},
  ) {
    const url = okxWs(this.demo, kind);
    const connect = (delay = 0) =>
      setTimeout(() => {
        const ws = new WebSocket(url);
        let ping: ReturnType<typeof setInterval> | undefined;
        const subscribe = () => { ws.send(JSON.stringify({ op: "subscribe", args })); onReady(); };
        ws.onopen = () => {
          delay = 0;
          ping = setInterval(() => { try { ws.send("ping"); } catch {} }, PING_MS);
          if (kind === "private") onOpen(ws); else subscribe();
        };
        ws.onmessage = (e) => {
          onAlive();
          const text = String(e.data);
          if (text === "pong") return;
          let m: { event?: string; code?: string; msg?: string; arg?: { channel: string }; data?: unknown[] };
          try { m = JSON.parse(text); } catch { return; }
          if (m.event === "login") { if (m.code === "0") subscribe(); return; }
          if (m.event === "error") { console.warn(`okx ${kind} socket: ${m.code} ${m.msg}`); return; }
          if (m.arg && m.data) onData(m.arg.channel, m.data);
        };
        ws.onclose = () => { clearInterval(ping); onClose(); connect(Math.min(delay + 1000, 10_000)); };
        ws.onerror = () => ws.close();
      }, delay);
    connect();
  }
}
