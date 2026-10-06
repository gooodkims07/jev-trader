/**
 * An OKX USDT-margined perpetual swap (OKX_INST_ID, default XRP-USDT-SWAP) as a Venue.
 *
 * No chain, so a timer stands in for the block. Block numbers are seconds (floor(now / 1000)) whatever the
 * tick, so they stay monotonic when OKX_TICK_MS changes while running; the loop runs once per tick
 * (every OKX_TICK_MS) and trade prints are stamped with the second of their exchange timestamp. OKX sizes are contracts (ctVal of the
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
import type { ManualOrder, ManualTrading, TradeInfo } from "./venue";
import { bookFromLevels, summarize, type InstrumentChoice, type MarketExec, type MarketFill, type Book, type MakerFill, type OrderId, type Quote, type QuoteResult, type Side, type TradePrint, type TradeSource, type TradeSummary, type Venue, type VenueInfo } from "./venue";

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
  private minSz = 0;
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

  /** Block number for a time: the second. The tick decides how often the loop runs, not the numbering. */
  tickOf(ms: number) { return Math.floor(ms / 1000); }

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
    this.minSz = Number(inst.minSz);
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
    this.lever = config.okx.leverage;
    await this.readFee();
    await this.cancelLeftovers();
    await this.cancelLeftoverStops();
    await this.refresh();
    if (this.posContracts !== 0) {
      // The spike strategy matches the exchange's position every 2 s and takes over one it does not hold.
      if (config.strategy !== "spike") throw new Error(`okx: ${this.instId} already has a position of ${this.posContracts * this.ctVal} ${this.base}. Close it first: the bot's cap and P&L start from flat.`);
      console.log(`okx: ${this.instId} has a position of ${this.posContracts * this.ctVal} ${this.base}; the spike bot takes it over, with new exits`);
    }
    this.connectPrivate();
    console.log(`okx account · ${this.availUsdt.toFixed(2)} USDT available · ${config.okx.leverage}x ${config.okx.marginMode} · maker fee ${(this.makerFeeRate * 100).toFixed(4)}%`);
  }

  /** One call per tick, aligned to the wall clock. The tick length is read each time, so it can change while running. */
  startClock(onBlock: (block: number) => void) {
    let last = Math.floor(Date.now() / config.okx.tickMs), lastMs = config.okx.tickMs;
    setInterval(() => {
      const now = Date.now(), ms = config.okx.tickMs;
      const t = Math.floor(now / ms);
      if (ms !== lastMs) { lastMs = ms; last = t; this.info.blockMs = ms; return; } // new tick length: start on its next boundary
      if (t > last) { last = t; onBlock(this.tickOf(now)); }
    }, 50);
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

  /** The leverage set on OKX for this instrument. The setting can change while running; see syncLeverage. */
  private lever = 1;

  /**
   * Before opening from flat: set OKX to the leverage in the settings, if it changed. Not while a position is open
   * (on OKX an isolated position has one leverage, and changing it would move that position's margin).
   */
  private async syncLeverage() {
    if (this.lever === config.okx.leverage || this.posContracts !== 0) return;
    await this.api.signed("POST", "/api/v5/account/set-leverage", { instId: this.instId, lever: String(config.okx.leverage), mgnMode: config.okx.marginMode });
    console.log(`okx leverage ${this.lever}x -> ${config.okx.leverage}x`);
    this.lever = config.okx.leverage;
  }

  /** Reducing the position needs no new margin; adding needs notional / leverage, plus a fee's worth of headroom. */
  canAfford(side: Side, size: number, book: Book) {
    const reduces = side === "buy" ? this.posContracts < 0 : this.posContracts > 0;
    if (reduces && size / this.ctVal <= Math.abs(this.posContracts)) return true;
    const price = side === "buy" ? book.bid : book.ask;
    const lev = this.posContracts === 0 ? config.okx.leverage : this.lever; // an open position keeps its leverage
    return this.availUsdt >= (size * price) / lev * 1.01;
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

  /** Our emergency stops and exit OCOs left from an earlier run: stale (spike places new exits for a position it takes over). */
  /** The exit OCO of an earlier run kept for the position open at start (see takeCarriedExits). */
  private carriedExits: { tp: number; sl: number } | null = null;

  private async cancelLeftoverStops() {
    const open = await this.api.signed<{ algoId: string; algoClOrdId: string; ordType: string; tpTriggerPx: string; slTriggerPx: string }[]>("GET", "/api/v5/trade/orders-algo-pending", { ordType: "conditional,oco", instType: "SWAP", instId: this.instId }).catch(() => []);
    let ours = open.filter((o) => o.algoClOrdId?.startsWith(STOP_PREFIX));
    // A position is open (a restart): keep our exit OCO on the exchange and remember its levels, so the position is
    // never unprotected and keeps exits that were moved by hand. The next setExits replaces it.
    const pos = await this.api.signed<{ instId: string; pos: string }[]>("GET", "/api/v5/account/positions", { instId: this.instId }).catch(() => []);
    const oco = ours.find((o) => o.ordType === "oco" && Number(o.tpTriggerPx) > 0 && Number(o.slTriggerPx) > 0);
    if (oco && pos.some((p) => p.instId === this.instId && Number(p.pos) !== 0)) {
      this.exitAlgo = oco.algoId;
      this.carriedExits = { tp: Number(oco.tpTriggerPx), sl: Number(oco.slTriggerPx) };
      ours = ours.filter((o) => o !== oco);
      console.log(`okx: kept the exits left on the exchange: take-profit ${oco.tpTriggerPx} / stop ${oco.slTriggerPx}`);
    }
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

  /** For the dashboard's order book: one REST read per 400 ms at most, shared by every viewer. */
  private depthCache: { at: number; levels: number; p: Promise<{ bids: [number, number][]; asks: [number, number][]; last: { price: number; side: Side } | null; ts: number }> } | null = null;
  depth(levels: number) {
    // Up to 400 levels from /market/books; deeper (for a coarse price step on the dashboard) from /market/books-full.
    const n = Math.min(5000, Math.max(1, Math.round(levels)));
    if (this.depthCache && this.depthCache.levels >= n && Date.now() - this.depthCache.at < 400) return this.depthCache.p;
    const p = this.api.public<{ asks: string[][]; bids: string[][]; ts: string }[]>(n <= 400 ? "/api/v5/market/books" : "/api/v5/market/books-full", { instId: this.instId, sz: String(n) }).then(([b]) => {
      const side = (rows: string[][]) => rows.map((r) => [Number(r[0]), round(Number(r[1]) * this.ctVal, 6)] as [number, number]);
      const t = this.trades.recent(1)[0];
      return { bids: side(b?.bids ?? []), asks: side(b?.asks ?? []), last: t ? { price: t.price, side: t.side } : null, ts: Number(b?.ts ?? Date.now()) };
    });
    this.depthCache = { at: Date.now(), levels: n, p };
    p.catch(() => { if (this.depthCache?.p === p) this.depthCache = null; });
    return p;
  }

  /** Chart candles, one REST read per bar per 1.5 s at most (shared by every viewer). */
  private candleCache = new Map<string, { at: number; p: Promise<{ ts: number; o: number; h: number; l: number; c: number }[]> }>();
  candles(bar: string, limit: number) {
    const key = `${bar}:${limit}`, hit = this.candleCache.get(key);
    if (hit && Date.now() - hit.at < 1500) return hit.p;
    // OKX has no 10-minute bar: two 5-minute candles make one (aligned to :00, :10, :20...).
    const merge = bar === "10m" ? 2 : 1, okxBar = bar === "10m" ? "5m" : bar;
    const p = this.api.public<string[][]>("/api/v5/market/candles", { instId: this.instId, bar: okxBar, limit: String(Math.min(300, Math.max(1, limit * merge + merge))) })
      .then((rows) => {
        const list = rows.map((r) => ({ ts: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) })).reverse();
        if (merge === 1) return list;
        const out: typeof list = [], ms = 600_000;
        for (const c of list) {
          const t = Math.floor(c.ts / ms) * ms, last = out[out.length - 1];
          if (last && last.ts === t) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; }
          else out.push({ ...c, ts: t });
        }
        return out.slice(-limit);
      });
    this.candleCache.set(key, { at: Date.now(), p });
    p.catch(() => { if (this.candleCache.get(key)?.p === p) this.candleCache.delete(key); });
    return p;
  }

  /** 1-minute closes from OKX candles (confirmed ones only), oldest first: recent, then history pages of 100. */
  async closes(minutes: number) {
    type Row = [string, string, string, string, string, string, string, string, string];
    const out = new Map<number, number>();
    let rows = await this.api.public<Row[]>("/api/v5/market/candles", { instId: this.instId, bar: "1m", limit: "300" });
    for (;;) {
      for (const r of rows) if (r[8] === "1") out.set(Number(r[0]), Number(r[4]));
      if (out.size >= minutes || !rows.length) break;
      const oldest = rows[rows.length - 1]![0];
      rows = await this.api.public<Row[]>("/api/v5/market/history-candles", { instId: this.instId, bar: "1m", limit: "100", after: oldest });
    }
    return [...out].sort((a, b) => a[0] - b[0]).slice(-minutes).map(([ts, close]) => ({ ts, close }));
  }

  /** Live only: market orders, the position, fills, and exchange-side exits. See MarketExec. */
  get exec(): MarketExec | undefined {
    if (!this.live) return undefined;
    return {
      marketOrder: (side, size, reduceOnly) => this.marketOrder(side, size, reduceOnly),
      positionNow: () => this.positionNow(),
      exitsState: () => this.exitsState(),
      takeCarriedExits: () => { const x = this.carriedExits; this.carriedExits = null; return x; },
      fillsSince: (since, side) => this.fillsSince(since, side),
      setExits: (p) => this.setExits(p),
    };
  }

  private exitAlgo: string | null = null;

  /** Live only: orders by hand from the dashboard, tagged "man" so the bot's own clean-ups (prefix "jev") leave them. */
  get manual(): ManualTrading | undefined {
    if (!this.live) return undefined;
    return { info: () => this.tradeInfo(), place: (o) => this.placeManual(o), cancel: (id) => this.cancelManual(id), amend: (id, px) => this.amendManual(id, px) };
  }

  private mmrCache: number | null = null;
  private async tradeInfo(): Promise<TradeInfo> {
    const [base, quote] = this.instId.split("-");
    const [bal, pos, orders, lim, book] = await Promise.all([
      this.api.signed<{ details: { ccy: string; availBal: string; eq: string }[] }[]>("GET", "/api/v5/account/balance", { ccy: "USDT" }),
      this.api.signed<{ instId: string; pos: string; avgPx: string }[]>("GET", "/api/v5/account/positions", { instId: this.instId }),
      this.api.signed<{ ordId: string; clOrdId: string; side: Side; ordType: string; px: string; sz: string; accFillSz: string; reduceOnly: string; cTime: string }[]>("GET", "/api/v5/trade/orders-pending", { instType: "SWAP", instId: this.instId }),
      this.api.public<{ buyLmt: string; sellLmt: string }[]>("/api/v5/public/price-limit", { instId: this.instId }).catch(() => []),
      this.readBook(),
    ]);
    if (this.mmrCache === null) {
      const tiers = await this.api.public<{ tier: string; mmr: string }[]>("/api/v5/public/position-tiers", { instType: "SWAP", tdMode: config.okx.marginMode, instFamily: `${base}-${quote}` }).catch(() => []);
      this.mmrCache = Number(tiers.find((t) => t.tier === "1")?.mmr ?? 0.005);
    }
    const p = pos.find((x) => x.instId === this.instId && Number(x.pos) !== 0);
    const usdt = bal[0]?.details.find((d) => d.ccy === "USDT");
    this.availUsdt = Number(usdt?.availBal ?? this.availUsdt);
    return {
      available: this.availUsdt, equity: Number(usdt?.eq ?? this.availUsdt), maxMarginPct: config.risk.manualMaxMarginPct, leverage: config.okx.leverage, marginMode: config.okx.marginMode,
      lot: round(this.lotSz * this.ctVal, 10), min: round(this.minSz * this.ctVal, 10), tick: 10 ** -this.tickDec, mmr: this.mmrCache,
      limits: lim[0] ? { buy: Number(lim[0].buyLmt), sell: Number(lim[0].sellLmt) } : null,
      bid: book.bid, ask: book.ask,
      position: { size: p ? round(Number(p.pos) * this.ctVal, 10) : 0, avgPx: p ? Number(p.avgPx) : 0 },
      orders: orders.map((o) => ({ ordId: o.ordId, side: o.side, type: o.ordType, price: Number(o.px), size: round(Number(o.sz) * this.ctVal, 10), filled: round(Number(o.accFillSz) * this.ctVal, 10), reduceOnly: o.reduceOnly === "true", ts: Number(o.cTime), manual: !o.clOrdId?.startsWith(CL_PREFIX) })),
    };
  }

  private async placeManual(o: ManualOrder) {
    const why = this.checkSize(o.size);
    if (why) throw new Error(`amount ${why}`);
    let price: number | null = null;
    if (o.type === "limit") {
      price = o.bbo ? (o.side === "buy" ? (await this.readBook()).bid : (await this.readBook()).ask) : Number(o.price);
      if (!(price > 0)) throw new Error("price must be above 0");
      const ticks = price * 10 ** this.tickDec;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-6) throw new Error(`price must be a multiple of ${10 ** -this.tickDec}`);
      price = round(price, this.tickDec);
    }
    if (!o.reduceOnly) await this.syncLeverage();
    const [r] = await this.api.signed<PlaceResult[]>("POST", "/api/v5/trade/order", {
      instId: this.instId, tdMode: config.okx.marginMode, side: o.side, ordType: o.type,
      ...(price !== null ? { px: price.toFixed(this.tickDec) } : {}),
      sz: String(round(o.size / this.ctVal, 8)), clOrdId: newClOrdId("man"), ...(o.reduceOnly ? { reduceOnly: true } : {}),
    });
    console.log(`okx manual ${o.type} ${o.side} ${o.size} ${this.base}${price !== null ? ` at ${price}` : ""}${o.reduceOnly ? " reduce-only" : ""}: order ${r!.ordId}`);
    // Market: wait for the fill (a limit rests; its fill reaches the bot through the position sync).
    for (let i = 0; i < (o.type === "market" ? 30 : 1); i++) {
      const [x] = await this.api.signed<{ state: string; avgPx: string; accFillSz: string }[]>("GET", "/api/v5/trade/order", { instId: this.instId, ordId: r!.ordId });
      const filled = round(Number(x?.accFillSz ?? 0) * this.ctVal, 10);
      if (o.type === "limit" || x?.state === "filled" || x?.state === "canceled") return { ordId: r!.ordId, state: x?.state ?? "live", filled, avgPx: Number(x?.avgPx || 0), price };
      await Bun.sleep(100);
    }
    return { ordId: r!.ordId, state: "partially_filled", filled: 0, avgPx: 0, price };
  }

  private async amendManual(ordId: string, price: number) {
    const ticks = price * 10 ** this.tickDec;
    if (!(price > 0) || Math.abs(ticks - Math.round(ticks)) > 1e-6) throw new Error(`price must be a multiple of ${10 ** -this.tickDec}`);
    await this.api.signed("POST", "/api/v5/trade/amend-order", { instId: this.instId, ordId, newPx: price.toFixed(this.tickDec) });
    console.log(`okx manual amend: order ${ordId} to ${price}`);
  }

  private async cancelManual(ordId: string) {
    await this.api.signed("POST", "/api/v5/trade/cancel-order", { instId: this.instId, ordId });
    console.log(`okx manual cancel: order ${ordId}`);
  }

  /** Market order, then read it back until filled (a market order on a live book fills at once). */
  private async marketOrder(side: Side, size: number, reduceOnly: boolean): Promise<MarketFill> {
    if (!reduceOnly) await this.syncLeverage();
    const [r] = await this.api.signed<PlaceResult[]>("POST", "/api/v5/trade/order", {
      instId: this.instId, tdMode: config.okx.marginMode, side, ordType: "market",
      sz: String(round(size / this.ctVal, 8)), clOrdId: newClOrdId(), ...(reduceOnly ? { reduceOnly: true } : {}),
    });
    for (let i = 0; i < 30; i++) {
      const [o] = await this.api.signed<{ state: string; avgPx: string; accFillSz: string; fee: string }[]>("GET", "/api/v5/trade/order", { instId: this.instId, ordId: r!.ordId });
      const filled = Number(o?.accFillSz ?? 0) * this.ctVal;
      if (o && (o.state === "filled" || (o.state === "canceled" && filled > 0))) {
        this.posContracts += (side === "buy" ? 1 : -1) * (filled / this.ctVal);
        return { ordId: r!.ordId, avgPx: Number(o.avgPx), size: round(filled, 10), fee: -Number(o.fee || 0) };
      }
      if (o && o.state === "canceled") throw new Error(`okx market ${side} ${size} ${this.base}: canceled unfilled`);
      await Bun.sleep(100);
    }
    throw new Error(`okx market ${side} ${size} ${this.base}: not filled after 3 s (order ${r!.ordId})`);
  }

  private async positionNow() {
    const ps = await this.api.signed<{ instId: string; pos: string; avgPx: string }[]>("GET", "/api/v5/account/positions", { instId: this.instId });
    const p = ps.find((x) => x.instId === this.instId && Number(x.pos) !== 0);
    this.posContracts = p ? Number(p.pos) : 0;
    return { size: round(this.posContracts * this.ctVal, 10), avgPx: p ? Number(p.avgPx) : 0 };
  }

  private async fillsSince(since: number, side: Side) {
    const fs = await this.api.signed<{ side: Side; fillPx: string; fillSz: string; fee: string; ts: string; billId: string; tradeId: string; ordId: string }[]>("GET", "/api/v5/trade/fills", { instType: "SWAP", instId: this.instId, limit: "100" });
    return fs.filter((f) => f.side === side && Number(f.ts) >= since)
      .map((f) => ({ px: Number(f.fillPx), size: Number(f.fillSz) * this.ctVal, fee: -Number(f.fee || 0), ts: Number(f.ts), id: f.billId || `${f.ordId}:${f.tradeId}`, ordId: f.ordId }))
      .sort((a, b) => a.ts - b.ts);
  }

  private async exitsState(): Promise<"live" | "tp" | "sl" | "gone" | null> {
    if (!this.exitAlgo) return null;
    const [a] = await this.api.signed<{ state: string; actualSide: string }[]>("GET", "/api/v5/trade/order-algo", { algoId: this.exitAlgo });
    if (!a || a.state === "live" || a.state === "pause" || a.state === "partially_effective") return "live";
    if (a.state === "effective") return a.actualSide === "tp" ? "tp" : a.actualSide === "sl" ? "sl" : "gone";
    return "gone";
  }

  /** One OCO (take-profit and stop, market on trigger, last price) closing the whole position; replaces the last. */
  private async setExits(p: { side: Side; tp: number; sl: number } | null): Promise<boolean> {
    if (this.exitAlgo) {
      await this.api.signed("POST", "/api/v5/trade/cancel-algos", [{ algoId: this.exitAlgo, instId: this.instId }]).catch(() => {});
      this.exitAlgo = null;
    }
    if (!p) return true;
    try {
      const [r] = await this.api.signed<{ algoId: string }[]>("POST", "/api/v5/trade/order-algo", {
        instId: this.instId, tdMode: config.okx.marginMode, side: p.side === "buy" ? "sell" : "buy", posSide: "net", ordType: "oco",
        closeFraction: "1", reduceOnly: true, cxlOnClosePos: true,
        tpTriggerPx: p.tp.toFixed(this.tickDec), tpOrdPx: "-1", tpTriggerPxType: "last",
        slTriggerPx: p.sl.toFixed(this.tickDec), slOrdPx: "-1", slTriggerPxType: "last",
        algoClOrdId: newClOrdId(STOP_PREFIX),
      });
      this.exitAlgo = r!.algoId;
      console.log(`okx exits on the exchange: take-profit ${p.tp.toFixed(this.tickDec)} / stop ${p.sl.toFixed(this.tickDec)}`);
      return true;
    } catch (e) {
      console.warn(`okx exits not placed (${(e as Error).message}); the bot watches them itself`);
      return false;
    }
  }

  private instCache: { at: number; list: InstrumentChoice[] } | null = null;

  /** Live USDT-margined perpetuals, most traded first (top 60), cached for 5 minutes. Public data only. */
  async instruments(): Promise<InstrumentChoice[]> {
    if (this.instCache && Date.now() - this.instCache.at < 300_000) return this.instCache.list;
    const [insts, tickers] = await Promise.all([
      this.api.public<(Instrument & { ctType: string })[]>("/api/v5/public/instruments", { instType: "SWAP" }),
      this.api.public<{ instId: string; last: string; volCcy24h: string }[]>("/api/v5/market/tickers", { instType: "SWAP" }),
    ]);
    const tick = new Map(tickers.map((t) => [t.instId, t]));
    const list = insts
      .filter((i) => i.instId.endsWith("-USDT-SWAP") && i.state === "live" && i.ctType === "linear" && tick.has(i.instId))
      .map((i) => {
        const t = tick.get(i.instId)!, ct = Number(i.ctVal);
        return { instId: i.instId, base: i.ctValCcy, last: Number(t.last), volUsd24h: Math.round(Number(t.volCcy24h) * Number(t.last)), lot: round(ct * Number(i.lotSz), 10), min: round(ct * Number(i.minSz), 10), tickSz: i.tickSz };
      })
      .sort((a, b) => b.volUsd24h - a.volUsd24h)
      .slice(0, 60);
    this.instCache = { at: Date.now(), list };
    return list;
  }

  /** A live run switches coins only when flat: the new coin's startup would not see this coin's position. */
  switchBlocker(): string | null {
    if (!this.live) return null;
    return this.posContracts !== 0 ? `a position of ${this.posContracts * this.ctVal} ${this.base} is open on ${this.instId}` : null;
  }

  checkSize(size: number): string | null {
    const lots = size / this.ctVal / this.lotSz;
    if (Math.abs(lots - Math.round(lots)) > 1e-9) return `must be a multiple of ${round(this.ctVal * this.lotSz, 8)} ${this.base}`;
    if (size / this.ctVal < this.minSz) return `must be at least ${round(this.minSz * this.ctVal, 8)} ${this.base}`;
    return null;
  }

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
