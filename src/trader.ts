import { appendFileSync, mkdirSync } from "node:fs";
import { config } from "./config";
import type { Action, Decision, Model, TradeState } from "./model";
import type { Book, CloseReason, Fill, MakerFill, OrderId, Quote, QuoteResult, Side, TradePrint, Venue } from "./venue";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  /** A stop or take-profit is closing the position (see config.risk), or null. */
  closing: CloseReason | null;
  totals: Totals;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  /** Exchange fees on fills, net of rebates (OKX charges or rebates makers; Kuru fills carry 0). */
  feesUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

/** `ahead`: dry run only, the size resting at our price before us (price-time priority). */
interface Resting { side: Side; price: number; size: number; block: number; ahead?: number }

/** Simulated orders have negative ids; they never go to the venue. */
const isReal = (id: OrderId) => typeof id === "string" || id > 0;

/**
 * Every block: read the book, ask the model buy or sell, and post one post-only limit order on
 * that side (`quoteInsideTicks` inside the touch), cancelling whatever we had resting. One request
 * in flight; a block that arrives while the previous one is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its confirmation
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the venue's trade feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills from real prints, behind whatever already rested at its price.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  /** Orders we know are resting on the book (live: from confirmations; dry run: last block's simulated order). */
  private orders = new Map<OrderId, Resting>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote>();
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  /** A stop or take-profit that is closing the position. Session reasons stop the bot once flat. */
  private closing: CloseReason | null = null;
  private halted = false;
  /** Called once when a session stop or take-profit has closed the position: the bot should shut down. */
  onHalt: (reason: CloseReason) => void = () => {};
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, feesUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };

  constructor(
    private venue: Venue,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
  }

  async onBlock(block: number) {
    if (this.halted) return;
    this.totals.blocks++;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.venue.refresh().catch(() => {}); // balances, fee estimates
    if (this.busy) {
      this.totals.lateBlocks++;
      if (this.lastBook) this.emit(block, this.lastBook, null, null, true);
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = await this.venue.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.venue.trades.poll(block).then(() => this.harvest()); // off the hot path: prints (and our fills) since the last poll

      this.checkRisk(book);
      if (this.closing?.startsWith("session") && this.position.mon === 0) {
        // A session stop or take-profit has nothing left to close: stop here.
        this.halted = true;
        this.emit(block, book, null, null, false);
        this.onHalt(this.closing);
        return;
      }

      const decision = await this.model.decide(this.buildState(block, book));
      const wanted: Side = decision.action === "sell" ? "sell" : "buy";
      const other: Side = wanted === "buy" ? "sell" : "buy";
      // While closing, the side is the one that shrinks the position. Otherwise the position cap (and, live,
      // funds) can only pick the reducing side. The probabilities still show the model's call either way.
      const closeSide: Side | null = this.closing && this.position.mon !== 0 ? (this.position.mon > 0 ? "sell" : "buy") : null;
      const side: Side | null = closeSide ?? (this.allowed(wanted, book) ? wanted : this.allowed(other, book) ? other : null);
      this.totals.decisions++;
      this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;

      let quote: Quote | null = null;
      if (side) {
        decision.action = side;
        const cancel = [...this.orders.keys()].filter(isReal);
        const size = closeSide ? Math.abs(this.position.mon) : config.tradeSize;
        quote = await this.venue.send(block, side, size, book, cancel, side !== wanted, !!closeSide);
        if (closeSide) quote.close = this.closing!;
        this.totals.quotes++;
        if (quote.status === "sim") {
          this.orders.clear(); // the simulated cancel
          this.orders.set(--this.simId, { side, price: quote.price, size: quote.size, block, ahead: queueAhead(side, quote.price, book) });
        } else if (quote.ref) {
          this.inflight.set(quote.ref, quote);
        }
      }
      this.emit(block, book, decision, quote, false, { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) });
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** Confirmations for earlier sends, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.venue.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, canceled }: QuoteResult) {
    if (quote.ref) this.inflight.delete(quote.ref);
    this.totals.gasMon += quote.gasMon; // charged on reverts too
    if (quote.status === "reverted") this.totals.reverted++;
    for (const id of canceled) this.orders.delete(id);
    if (quote.status === "placed" && quote.orderId !== null) this.orders.set(quote.orderId, { side: quote.side, price: quote.price, size: quote.size, block });
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = quote;
    this.onQuote(block, quote);
  }

  /** After each trade poll: apply our maker fills (live) or simulate them against the new prints (dry run). */
  private harvest() {
    const trades = this.venue.trades;
    const prints = trades.drainPrints();
    const fills: Fill[] = this.venue.live ? this.liveFills(trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      const b = (f as Fill & { block: number }).block;
      byBlock.set(b, [...(byBlock.get(b) ?? []), f]);
    }
    if (this.venue.live) this.venue.protect?.({ mon: this.position.mon, entry: this.entryPrice() });
    for (const [block, fs] of byBlock) {
      const fill = aggregate(fs, Math.max(4, this.venue.info.sizeDecimals));
      const e = this.history.find((h) => h.block === block);
      if (e) e.fill = fill;
      this.onFill(block, fill);
    }
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.size = f.updatedSize;
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, fee: f.fee, block: f.block });
    }
    return out;
  }

  /**
   * A simulated order placed at block N is on the book from N+1, behind the size that already rested at
   * its price (`ahead`; 0 when it improved the touch). Only taker flow against our side counts:
   *   - a print AT our price eats the queue ahead of us first, and fills us with whatever is left;
   *   - a print THROUGH our price means our whole level was taken, so the rest of our order fills.
   * Size ahead that cancels is not credited, so this errs toward fewer fills, never more.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        const against = o.side === "buy" ? p.side === "sell" : p.side === "buy";
        if (!against) continue;
        const eps = o.price * 1e-9;
        const at = Math.abs(p.price - o.price) <= eps;
        const through = o.side === "buy" ? p.price < o.price - eps : p.price > o.price + eps;
        if (!at && !through) continue;
        let size: number;
        if (through) {
          o.ahead = 0;
          size = o.size;
        } else {
          const eaten = Math.min(o.ahead ?? 0, p.size);
          o.ahead = (o.ahead ?? 0) - eaten;
          size = Math.min(o.size, p.size - eaten);
        }
        if (size <= 1e-12) continue;
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        out.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, fee: size * o.price * this.venue.makerFeeRate, block: p.block });
      }
    }
    return out;
  }

  /** P&L of this run at `mid`: realized + unrealized - gas - fees, in the quote currency. */
  private sessionPnl(mid: number) {
    const t = this.totals;
    return t.realizedUsd + this.unrealizedUsd(mid) - t.gasMon * mid - t.feesUsd;
  }

  /**
   * Start closing when a stop or take-profit is hit (config.risk; 0 turns a check off). A position close
   * ends once flat and trading resumes; a session close ends the run. Closing is never cancelled by the
   * price coming back.
   */
  private checkRisk(book: Book) {
    const r = config.risk;
    if (this.closing) {
      if (this.closing.startsWith("position") && this.position.mon === 0) {
        console.log(`${this.closing}: position closed, trading on`);
        this.closing = null;
      }
      if (this.closing) return;
    }
    const pnl = this.sessionPnl(book.mid);
    let reason: CloseReason | null = null;
    if (r.sessionStopLoss > 0 && pnl <= -r.sessionStopLoss) reason = "session-stop";
    else if (r.sessionTakeProfit > 0 && pnl >= r.sessionTakeProfit) reason = "session-take";
    else if (this.position.mon !== 0) {
      const entry = this.entryPrice()!;
      const favour = ((book.mid - entry) / entry) * Math.sign(this.position.mon) * 100; // % move in our favour
      if (r.positionStopPct > 0 && favour <= -r.positionStopPct) reason = "position-stop";
      else if (r.positionTakePct > 0 && favour >= r.positionTakePct) reason = "position-take";
    }
    if (!reason) return;
    this.closing = reason;
    console.log(`${reason}: session P&L ${pnl.toFixed(4)}, position ${this.position.mon} @ ${this.entryPrice() ?? "-"}, mid ${book.mid}: closing with reduce-only post-only orders${reason.startsWith("session") ? ", then stopping" : ""}`);
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const q of this.inflight.values()) if (q.side === side) mon += q.size;
    return mon;
  }

  /** Would this order, and everything already resting on its side, keep us inside the cap and (live) inside funds? */
  private allowed(side: Side, book: Book) {
    const size = config.tradeSize;
    const exposure = side === "buy" ? this.position.mon + this.restingMon("buy") + size : this.position.mon - this.restingMon("sell") - size;
    if (Math.abs(exposure) > config.maxPosition) return false;
    return !this.venue.live || this.venue.canAfford(side, size, book);
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const { priceDecimals: pd, sizeDecimals: sd } = this.venue.info;
    const lvl = (l: [number, number]) => `${l[0].toFixed(pd)} x ${round(l[1], sd)}`;
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, sd), ask: round(v.ask, sd) };
    return {
      market: this.venue.info.symbol,
      block,
      horizonBlocks: H,
      blockMs: this.venue.info.blockMs,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(pd + (this.venue.info.name === "kuru" ? 0 : 1))).join(" "),
      trades: this.venue.trades.summary(H, block),
      recentTrades: this.venue.trades.recent(10).map((t) => `${t.block} ${t.side} ${round(t.size, sd)} @ ${t.price.toFixed(pd)}`),
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    this.totals.feesUsd += f.fee;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    this.totals.fills++;
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, late: boolean, timing?: Timing) {
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd - t.feesUsd; // = sessionPnl(book.mid)
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      fill: null,
      resting: { bidMon: round(this.restingMon("buy"), this.venue.info.sizeDecimals), askMon: round(this.restingMon("sell"), this.venue.info.sizeDecimals) },
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      closing: this.closing,
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), feesUsd: round(t.feesUsd, 6), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3) },
    };
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    appendFileSync("data/events.jsonl", JSON.stringify(event) + "\n");
    this.onEvent(event, timing);
  }
}

/** Size already resting at `price` on our side of the book: the queue a new order joins behind. 0 inside the spread. */
export function queueAhead(side: Side, price: number, book: Book): number {
  const levels = side === "buy" ? book.levels.bids : book.levels.asks;
  const level = levels.find(([p]) => Math.abs(p - price) <= price * 1e-9);
  return level ? level[1] : 0;
}

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[], sizeDecimals: number): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  const fee = fills.reduce((s, f) => s + f.fee, 0);
  return { side, size: round(size, sizeDecimals), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated, fee };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
