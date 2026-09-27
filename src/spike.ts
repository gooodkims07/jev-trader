/**
 * Spike strategy (STRATEGY=spike, OKX, dry run only for now).
 *
 * Every tick the mid is compared with 1 and 3 minutes ago. A move of at least SPIKE_1M_PCT or
 * SPIKE_3M_PCT is a spike: Jev is asked to go long, go short, or stay out. A position opens at market
 * (simulated at the touch, taker fee) and closes at the take-profit, the stop-loss (both ROE, divided by
 * leverage into price) or after SPIKE_MAX_HOLD_MIN minutes. One position at a time.
 *
 * To judge Jev, two rules shadow every spike with the same exits: "fade" (against the move) and
 * "follow" (with it), each one position at a time. Every spike and every closed trade, Jev's and the
 * shadows', goes to data/spike.jsonl; `bun run scripts/spike-report.ts` compares them.
 *
 * Block events keep the Trader's shape, so the dashboard and the SSE stream work unchanged.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { Action, Decision } from "./model";
import type { BlockEvent, Totals } from "./trader";
import type { Book, Fill, Quote, Side, Venue, VenueInfo } from "./venue";

const TICKS_1M = (ms: number) => Math.round(60_000 / ms);
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export interface SpikeState {
  market: string;
  mid: number;
  spreadBps: number;
  /** The move that triggered this question. */
  spike: { window: "1m" | "3m"; direction: "up" | "down"; movePct: number; fromPrice: number };
  returnsPct: { last1m: number; last3m: number; last5m: number };
  /** Mid every 10 s over the last 5 minutes, oldest first. */
  recentMids: string;
  bookImbalance: number;
  depth: { [band: string]: { bid: number; ask: number } };
  book: { bids: string[]; asks: string[] };
  /** Taker prints over the last 3 minutes. cvdMon = taker buys minus taker sells, in the coin. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastSide: Side | null };
  recentTrades: string[];
  plan: { leverage: number; takeProfitPct: number; stopLossPct: number; takeProfitRoePct: number; stopLossRoePct: number; maxHoldMin: number; takerFeeBps: number };
  fundingRatePct: number | null;
}

export interface SpikeModel {
  readonly name: string;
  decide(state: SpikeState): Promise<Decision>;
}

export function spikeQuestions(v: VenueInfo) {
  const b = v.base;
  return {
    direction: {
      type: "choice",
      instructions: {
        question: "The price just moved sharply (see `spike`). Go long now, go short now, or stay out?",
        goal: `Trade short-lived spikes on the ${b}-USDT perpetual swap on ${v.label}. When the price moves at least ${config.spike.move1mPct}% in 1 minute or ${config.spike.move3mPct}% in 3 minutes, you decide. Long or short opens a position at market now, paying \`plan.takerFeeBps\` each way. It closes when the price moves \`plan.takeProfitPct\` in our favour or \`plan.stopLossPct\` against us, or after \`plan.maxHoldMin\` minutes. After an up spike, long follows the move and short fades it; after a down spike it is the other way round. The stop is further away than the take-profit, so a trade has to hit its take-profit first well over half the time to pay; stay out unless one side clearly has the better odds.`,
        timing: "The order fills at market within a second. The position is then watched every second against the mid until an exit.",
        inputs: `\`spike\` is the triggering move. \`returnsPct\` and \`recentMids\` show the path over the last 5 minutes. \`trades\` and \`recentTrades\` show taker flow over the last 3 minutes: heavy flow in the spike's direction that is dying out can mean the move is exhausted and will give some back; flow still building can mean it continues. \`book\`, \`depth\` and \`bookImbalance\` show resting liquidity; thin depth on one side means the price moves easily that way. \`fundingRatePct\` is per funding period; positive means longs pay shorts. Sizes and every field ending in \`Mon\` are in ${b}.`,
      },
      criteria: {
        buy: `Go long at market: from here the price is more likely to rise \`plan.takeProfitPct\` than to fall \`plan.stopLossPct\` within \`plan.maxHoldMin\` minutes.`,
        sell: `Go short at market: from here the price is more likely to fall \`plan.takeProfitPct\` than to rise \`plan.stopLossPct\` within \`plan.maxHoldMin\` minutes.`,
        hold: "Stay out: neither side clearly has the better odds of reaching its take-profit before its stop.",
      } as Record<string, string>,
    },
  } as const;
}

export class JevSpikeModel implements SpikeModel {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);
  private questions: ReturnType<typeof spikeQuestions>;
  constructor(v: VenueInfo) { this.questions = spikeQuestions(v); }

  async decide(state: SpikeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: this.questions, maxRetries: 0 });
    const a = r.answers.direction;
    const p = (a.probabilities ?? { [a.choice]: 1 }) as Record<string, number>;
    return {
      action: a.choice as Action,
      probabilities: { buy: p.buy ?? 0, sell: p.sell ?? 0, hold: p.hold ?? 0 },
      upIn10: p.buy ?? 0, latencyMs: performance.now() - t0, inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Stand-in without Jev: fades spikes where the last minute's taker flow ran with the move. */
export class MockSpikeModel implements SpikeModel {
  readonly name = "mock";
  async decide(s: SpikeState): Promise<Decision> {
    const up = s.spike.direction === "up";
    const withFlow = up ? s.trades.cvdMon > 0 : s.trades.cvdMon < 0;
    const action: Action = !withFlow ? "hold" : up ? "sell" : "buy";
    const probabilities = action === "hold" ? { buy: 0.2, sell: 0.2, hold: 0.6 } : action === "buy" ? { buy: 0.6, sell: 0.2, hold: 0.2 } : { buy: 0.2, sell: 0.6, hold: 0.2 };
    await Bun.sleep(80);
    return { action, probabilities, upIn10: probabilities.buy, latencyMs: 80, inputTokens: 1500 };
  }
}

export const createSpikeModel = (v: VenueInfo): SpikeModel => (config.model === "jev" ? new JevSpikeModel(v) : new MockSpikeModel());

type Who = "jev" | "fade" | "follow";
interface Open { who: Who; side: Side; entry: number; size: number; openedAt: number; spikeBlock: number; tp: number; sl: number }

export class SpikeTrader {
  readonly history: BlockEvent[] = [];
  onHalt: (reason: string) => void = () => {};
  private mids: number[] = [];
  private busy = false;
  private cooldownUntil = 0;
  private open = new Map<Who, Open>();
  private realized = 0; // Jev's closed trades, quote currency, fees included
  private feesUsd = 0;
  private closed = { jev: 0, fade: 0, follow: 0 };
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, skips: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, feesUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };
  private readonly tick1m: number;
  private readonly tpPct = config.spike.takeProfitRoePct / config.okx.leverage;
  private readonly slPct = config.spike.stopLossRoePct / config.okx.leverage;

  constructor(
    private venue: Venue,
    private model: SpikeModel,
    private onEvent: (e: BlockEvent, note?: string) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
  ) {
    if (venue.live) throw new Error("STRATEGY=spike is dry run only for now: set DRY_RUN=true");
    mkdirSync("data", { recursive: true });
    this.tick1m = TICKS_1M(venue.info.blockMs);
  }

  describe() {
    const s = config.spike;
    return `spike · trigger ${s.move1mPct}% in 1m or ${s.move3mPct}% in 3m · exits ROE +${s.takeProfitRoePct}% / -${s.stopLossRoePct}% at ${config.okx.leverage}x = price +${this.tpPct}% / -${this.slPct}% · max ${s.maxHoldMin} min · shadows: fade, follow · log data/spike.jsonl`;
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    if (this.totals.blocks % config.refreshBlocks === 0) this.venue.refresh().catch(() => {});
    if (this.busy) { this.totals.lateBlocks++; return; }
    this.busy = true;
    try {
      const book = await this.venue.readBook();
      this.mids.push(book.mid);
      if (this.mids.length > this.tick1m * 6) this.mids.shift();
      let quote: Quote | null = null, fill: Fill | null = null, decision: Decision | null = null, note = "";

      // Exits first, for Jev and the shadows.
      for (const o of [...this.open.values()]) {
        const r = this.exitReason(o, book, block);
        if (!r) continue;
        const res = this.close(o, book, block, r);
        if (o.who === "jev") { ({ quote, fill } = res); note = `EXIT ${r} ${res.pnlPct >= 0 ? "+" : ""}${res.pnlPct.toFixed(3)}% (ROE ${(res.pnlPct * config.okx.leverage).toFixed(1)}%)`; }
      }

      const spike = block >= this.cooldownUntil ? this.detect(book) : null;
      if (spike) {
        this.cooldownUntil = block + Math.round((config.spike.cooldownSec * 1000) / this.venue.info.blockMs);
        const followSide: Side = spike.direction === "up" ? "buy" : "sell";
        const fadeSide: Side = followSide === "buy" ? "sell" : "buy";
        for (const [who, side] of [["fade", fadeSide], ["follow", followSide]] as const) if (!this.open.has(who)) this.openPos(who, side, book, block);
        if (!this.open.has("jev")) {
          decision = await this.model.decide(this.state(book, spike));
          this.totals.decisions++;
          this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;
          if (decision.action === "hold") this.totals.skips++;
          else ({ quote, fill } = this.openPos("jev", decision.action, book, block));
          note = `SPIKE ${spike.direction} ${spike.movePct.toFixed(2)}% in ${spike.window} -> ${decision.action === "hold" ? "stay out" : decision.action === followSide ? `${decision.action} (follow)` : `${decision.action} (fade)`}`;
        } else note = `SPIKE ${spike.direction} ${spike.movePct.toFixed(2)}% in ${spike.window} (in a position: not asked)`;
        this.log({ type: "spike", block, ts: Date.now(), ...spike, mid: book.mid, asked: !!decision, jev: decision && { action: decision.action, probabilities: decision.probabilities, latencyMs: Math.round(decision.latencyMs) } });
      }
      this.emit(block, book, decision, quote, fill, note);
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** A move of at least move1mPct over 1 minute or move3mPct over 3 minutes, needing 3 minutes of history. */
  detect(book: Book): SpikeState["spike"] | null {
    const m = this.mids, n = m.length, t = this.tick1m;
    if (n <= 3 * t) return null;
    const r1 = (book.mid / m[n - 1 - t]! - 1) * 100, r3 = (book.mid / m[n - 1 - 3 * t]! - 1) * 100;
    if (Math.abs(r1) >= config.spike.move1mPct) return { window: "1m", direction: r1 > 0 ? "up" : "down", movePct: round(r1, 3), fromPrice: m[n - 1 - t]! };
    if (Math.abs(r3) >= config.spike.move3mPct) return { window: "3m", direction: r3 > 0 ? "up" : "down", movePct: round(r3, 3), fromPrice: m[n - 1 - 3 * t]! };
    return null;
  }

  private state(book: Book, spike: SpikeState["spike"]): SpikeState {
    const m = this.mids, n = m.length, t = this.tick1m, { priceDecimals: pd, sizeDecimals: sd } = this.venue.info;
    const ret = (k: number) => (n > k ? round((book.mid / m[n - 1 - k]! - 1) * 100, 3) : 0);
    const every = Math.max(1, Math.round(t / 6)); // every 10 s
    const lvl = (l: [number, number]) => `${l[0].toFixed(pd)} x ${round(l[1], sd)}`;
    const depth: SpikeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, sd), ask: round(v.ask, sd) };
    const block = book.block, s = this.venue.trades.summary(3 * t, block);
    return {
      market: this.venue.info.symbol, mid: book.mid, spreadBps: round(book.spreadBps, 2), spike,
      returnsPct: { last1m: ret(t), last3m: ret(3 * t), last5m: ret(5 * t) },
      recentMids: m.slice(-5 * t).filter((_, i, a) => (a.length - 1 - i) % every === 0).map((x) => x.toFixed(pd + 1)).join(" "),
      bookImbalance: round(book.imbalance, 3), depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      trades: { count: s.count, buyMon: round(s.buyMon, sd), sellMon: round(s.sellMon, sd), cvdMon: round(s.cvdMon, sd), vwap: s.vwap, lastSide: s.lastSide },
      recentTrades: this.venue.trades.recent(10).map((x) => `${x.side} ${round(x.size, sd)} @ ${x.price.toFixed(pd)}`),
      plan: { leverage: config.okx.leverage, takeProfitPct: this.tpPct, stopLossPct: this.slPct, takeProfitRoePct: config.spike.takeProfitRoePct, stopLossRoePct: config.spike.stopLossRoePct, maxHoldMin: config.spike.maxHoldMin, takerFeeBps: round(config.spike.takerFeeRate * 10_000, 2) },
      fundingRatePct: this.venue.extras?.().fundingRatePct ?? null,
    };
  }

  /** Market entry, simulated at the touch: a buy pays the ask, a sell gets the bid. */
  private openPos(who: Who, side: Side, book: Book, block: number) {
    const entry = side === "buy" ? book.ask : book.bid, size = config.tradeSize;
    const dir = side === "buy" ? 1 : -1;
    const o: Open = { who, side, entry, size, openedAt: block, spikeBlock: block, tp: entry * (1 + (dir * this.tpPct) / 100), sl: entry * (1 - (dir * this.slPct) / 100) };
    this.open.set(who, o);
    if (who !== "jev") return { quote: null, fill: null };
    const fee = size * entry * config.spike.takerFeeRate;
    this.feesUsd += fee;
    this.realized -= fee;
    this.totals.quotes++; this.totals.fills++;
    const quote: Quote = { side, price: entry, size, txHash: null, ref: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false };
    const fill: Fill = { side, size, price: entry, txHash: null, orderId: -block, simulated: true, fee };
    return { quote, fill };
  }

  /** Take-profit and stop-loss against the mid; the time limit against the open block. */
  private exitReason(o: Open, book: Book, block: number): "take-profit" | "stop-loss" | "time" | null {
    const long = o.side === "buy";
    if (long ? book.mid <= o.sl : book.mid >= o.sl) return "stop-loss";
    if (long ? book.mid >= o.tp : book.mid <= o.tp) return "take-profit";
    if ((block - o.openedAt) * this.venue.info.blockMs >= config.spike.maxHoldMin * 60_000) return "time";
    return null;
  }

  /** Market exit, simulated at the touch: closing a long sells at the bid, a short buys at the ask. */
  private close(o: Open, book: Book, block: number, reason: string) {
    this.open.delete(o.who);
    const long = o.side === "buy", exit = long ? book.bid : book.ask, dir = long ? 1 : -1;
    const fees = config.spike.takerFeeRate * (o.entry + exit) * o.size;
    const pnlUsd = dir * (exit - o.entry) * o.size - fees;
    const pnlPct = (pnlUsd / (o.entry * o.size)) * 100; // on notional, fees included
    this.closed[o.who]++;
    this.log({ type: "trade", who: o.who, side: o.side, spikeBlock: o.spikeBlock, openedAt: o.openedAt, closedAt: block, heldMin: round(((block - o.openedAt) * this.venue.info.blockMs) / 60_000, 1), entry: o.entry, exit, reason, pnlPct: round(pnlPct, 4), roePct: round(pnlPct * config.okx.leverage, 2), pnlUsd: round(pnlUsd, 5) });
    if (o.who !== "jev") return { quote: null, fill: null, pnlPct };
    const exitFee = config.spike.takerFeeRate * exit * o.size;
    this.feesUsd += exitFee;
    this.realized += dir * (exit - o.entry) * o.size - exitFee;
    this.totals.quotes++; this.totals.fills++;
    const side: Side = long ? "sell" : "buy";
    const quote: Quote = { side, price: exit, size: o.size, txHash: null, ref: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false, close: reason === "stop-loss" ? "position-stop" : "position-take" };
    const fill: Fill = { side, size: o.size, price: exit, txHash: null, orderId: -block, simulated: true, fee: exitFee };
    return { quote, fill, pnlPct };
  }

  private log(row: object) {
    appendFileSync("data/spike.jsonl", JSON.stringify(row) + "\n");
  }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, fill: Fill | null, note: string) {
    const o = this.open.get("jev"), dir = o ? (o.side === "buy" ? 1 : -1) : 0;
    const unreal = o ? dir * (book.mid - o.entry) * o.size : 0;
    const t = this.totals;
    t.feesUsd = round(this.feesUsd, 6);
    t.realizedUsd = round(this.realized + this.feesUsd, 4); // realized before fees; pnlUsd nets them
    t.pnlUsd = round(this.realized + unreal, 4);
    t.pnlMon = round(t.pnlUsd / book.mid, 4);
    t.pnlPct = round((t.pnlUsd / config.bankrollUsd) * 100, 3);
    const d = decision
      ? { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false }
      : { action: "hold" as Action, probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0, latencyMs: 0, late: false };
    const e: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: d, quote, fill, resting: { bidMon: 0, askMon: 0 },
      position: { side: dir > 0 ? "long" : dir < 0 ? "short" : "flat", size: o?.size ?? 0, entryPrice: o?.entry ?? null, unrealizedUsd: round(unreal, 4), unrealizedMon: round(unreal / book.mid, 4) },
      closing: null, totals: { ...t },
    };
    this.history.push(e);
    if (this.history.length > config.historySize) this.history.shift();
    if (fill) this.onFill(block, fill);
    this.onEvent(e, note);
  }
}
