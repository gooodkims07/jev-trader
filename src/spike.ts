/**
 * Spike strategy (STRATEGY=spike, OKX, dry run only for now).
 *
 * Every tick (OKX_TICK_MS, changeable while running) the mid is compared with 1 and 3 minutes ago. OKX block
 * numbers are seconds, so every window here is time: 1 and 3 minutes, the hold limit and the cooldown. A move of at least SPIKE_1M_PCT or
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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { Action, Decision } from "./model";
import type { BlockEvent, Totals } from "./trader";
import type { Book, Fill, MarketExec, Quote, Side, Venue, VenueInfo } from "./venue";

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** How a spike is defined now, for Jev's question. */
function triggerWords(): string {
  const s = config.spike;
  if (s.sides === 1) return `Only long positions are allowed, so a spike is a pullback: the price falling at least ${s.move1mPct}% from the highest price since the last spike (or reset)`;
  if (s.sides === 2) return `Only short positions are allowed, so a spike is a bounce: the price rising at least ${s.move1mPct}% from the lowest price since the last spike (or reset)`;
  return `When the price moves at least ${s.move1mPct}% in ${spanWords(s.window1Sec)} or ${s.move3mPct}% in ${spanWords(s.window2Sec)}`;
}

/** Sides spikes may open now: both, long only or short only (SPIKE_SIDES). */
export function allowedSides(): Side[] {
  return config.spike.sides === 1 ? ["buy"] : config.spike.sides === 2 ? ["sell"] : ["buy", "sell"];
}

/** What long / short / stay out mean while we already hold a position, as set now (SPIKE_MAX_ADDS, SPIKE_ALLOW_REVERSE). */
function positionRules(): string {
  const { maxAdds, allowReverse } = config.spike;
  if (!maxAdds && !allowReverse) return "";
  const same = maxAdds ? `choosing its side adds one more order at market while \`position.addsLeft\` is above 0 (the entry becomes the average and the take-profit and stop move with it), and keeps the position as it is once none are left` : "choosing its side keeps the position as it is";
  const other = allowReverse ? "choosing the other side closes it at market and opens the other way" : "choosing the other side keeps the position as it is";
  return ` When \`position\` is set we already hold one: ${same}; ${other}; staying out keeps it. The time limit counts from the first entry.`;
}

/** 30 -> "30s", 60 -> "1m", 180 -> "3m": how a window is written in rows, logs and the dashboard. */
export const spanLabel = (sec: number) => (sec % 60 === 0 ? `${sec / 60}m` : `${sec}s`);
/** 30 -> "30 seconds", 60 -> "1 minute", 180 -> "3 minutes": for Jev's question. */
const spanWords = (sec: number) => (sec % 60 === 0 ? (sec === 60 ? "1 minute" : `${sec / 60} minutes`) : `${sec} seconds`);

export interface SpikeState {
  market: string;
  mid: number;
  spreadBps: number;
  /** The move that triggered this question. */
  /** window: "30s", "1m", "5m"... the span the move was measured over. */
  spike: { window: string; direction: "up" | "down"; movePct: number; fromPrice: number };
  returnsPct: { last1m: number; last3m: number; last5m: number };
  /** Mid every 10 s over the last 5 minutes, oldest first. */
  recentMids: string;
  bookImbalance: number;
  depth: { [band: string]: { bid: number; ask: number } };
  book: { bids: string[]; asks: string[] };
  /** Taker prints over the longer spike window. cvdMon = taker buys minus taker sells, in the coin. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastSide: Side | null };
  recentTrades: string[];
  plan: { leverage: number; takeProfitPct: number; stopLossPct: number; takeProfitRoePct: number; stopLossRoePct: number; maxHoldMin: number; takerFeeBps: number; maxAdds: number; canReverse: boolean };
  fundingRatePct: number | null;
  /** Our position when the spike came, or null when flat. addsLeft: how many more same-side entries are allowed. */
  position: { side: "long" | "short"; sizeMon: number; entry: number; adds: number; addsLeft: number; heldMin: number; unrealizedRoePct: number } | null;
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
        goal: `Trade short-lived spikes on the ${b}-USDT perpetual swap on ${v.label}. ${triggerWords()}, you decide. Long or short opens a position at market now, paying \`plan.takerFeeBps\` each way. It closes when the price moves \`plan.takeProfitPct\` in our favour or \`plan.stopLossPct\` against us, or after \`plan.maxHoldMin\` minutes. After an up spike, long follows the move and short fades it; after a down spike it is the other way round. The stop is further away than the take-profit, so a trade has to hit its take-profit first well over half the time to pay; stay out unless one side clearly has the better odds.`,
        timing: `The order fills at market within a second. The position is then watched every tick against the mid until an exit.${positionRules()}`,
        inputs: `\`spike\` is the triggering move. \`returnsPct\` and \`recentMids\` show the path over the last 5 minutes. \`trades\` and \`recentTrades\` show taker flow over the last ${spanWords(Math.max(config.spike.window1Sec, config.spike.window2Sec))}: heavy flow in the spike's direction that is dying out can mean the move is exhausted and will give some back; flow still building can mean it continues. \`book\`, \`depth\` and \`bookImbalance\` show resting liquidity; thin depth on one side means the price moves easily that way. \`fundingRatePct\` is per funding period; positive means longs pay shorts. Sizes and every field ending in \`Mon\` are in ${b}.`,
      },
      // Only the sides allowed now (SPIKE_SIDES) are answers: with long only, Jev picks long or stay out.
      criteria: Object.fromEntries(
        (allowedSides().map((sd) => [sd, sd === "buy"
          ? `Go long at market: from here the price is more likely to rise \`plan.takeProfitPct\` than to fall \`plan.stopLossPct\` within \`plan.maxHoldMin\` minutes.`
          : `Go short at market: from here the price is more likely to fall \`plan.takeProfitPct\` than to rise \`plan.stopLossPct\` within \`plan.maxHoldMin\` minutes.`]) as [string, string][])
          .concat([["hold", allowedSides().length === 2
            ? "Stay out: neither side clearly has the better odds of reaching its take-profit before its stop."
            : `Stay out: ${allowedSides()[0] === "buy" ? "long" : "short"} is the only side allowed now, and it does not clearly have the better odds of reaching its take-profit before its stop.`]]),
      ) as Record<string, string>,
    },
  } as const;
}

export class JevSpikeModel implements SpikeModel {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);
  constructor(private readonly v: VenueInfo) {}

  async decide(state: SpikeState): Promise<Decision> {
    const t0 = performance.now();
    // Built per call: the question quotes the triggers, which the settings panel can change.
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: spikeQuestions(this.v), maxRetries: 0 });
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
/**
 * entry is the average over the first order and any adds; tp and sl follow it. Live (Jev only): openedTs is
 * when the first order filled, and exitsOnExchange says whether OKX holds the take-profit / stop OCO (else the
 * bot watches the levels itself).
 */
/**
 * mfe / mae: the best and worst the position stood while open, as a price move from its entry in % (+ in its
 * favour), from the mid at each tick. manual: opened outside the bot (taken over) or added to by hand.
 */
interface Open { who: Who; side: Side; entry: number; size: number; adds: number; openedAt: number; spikeBlock: number; tp: number; sl: number; openedTs?: number; exitsOnExchange?: boolean; entryFees?: number; mfe?: number; mae?: number; manual?: boolean }
/** What a spike did to one strategy's position. */
type Effect = "open" | "add" | "reverse" | "hold" | "out" | "not-asked" | "observed";

const LOG = "data/spike.jsonl";
/** A row of data/spike.jsonl. */
/** live: recorded by a live run (absent on rows from before this was recorded: those were all dry runs). */
interface SpikeRow { type: "spike"; instId?: string; live?: boolean; block: number; ts: number; window: string; direction: "up" | "down"; movePct: number; mid: number; asked: boolean; effect?: Effect; jev: { action: Action; probabilities: Record<Action, number>; latencyMs: number } | null }
/**
 * manual: Jev's row, but not Jev's trade (taken over from the OKX app, added to or closed by hand). mfePct /
 * maePct: see Open (absent on rows from before they were recorded).
 */
interface TradeRow { type: "trade"; instId?: string; live?: boolean; who: Who; side: Side; spikeBlock: number; openedAt: number; closedAt: number; heldMin: number; entry: number; exit: number; size?: number; adds?: number; reason: string; pnlPct: number; roePct: number; pnlUsd: number; ts?: number; manual?: boolean; mfePct?: number; maePct?: number }

/** Rows from before `manual` was recorded: taken over (no spike) or closed by hand. */
const isManual = (r: TradeRow) => r.who === "jev" && (r.manual ?? (r.spikeBlock === -1 || r.reason === "manual"));
/** Price moves (%) the excursion table reports, besides the plan's own take-profit and stop. */
const REACH_LEVELS = [0.5, 1, 1.5, 2, 3, 4];
type Stat = { trades: number; wins: number; avgPct: number; totalUsd: number; tp: number; sl: number; time: number };
/** How far trades went before they closed: averages, and the share that reached each price move either way. */
type Excursion = { measured: number; mfeAvg: number; maeAvg: number; reach: { pct: number; fav: number; adv: number }[] };

/** What the dashboard's spike panels read from GET /spike. */
export interface SpikeSnapshot {
  plan: { live: boolean; observe: boolean; sides: "both" | "long" | "short"; maxAdds: number; allowReverse: boolean; move1mPct: number; move3mPct: number; window1Sec: number; window2Sec: number; takeProfitRoePct: number; stopLossRoePct: number; takeProfitPct: number; stopLossPct: number; leverage: number; maxHoldMin: number; size: number; base: string };
  /** The mid's move now vs 1 and 3 minutes ago, in %, or null while history fills. */
  /** Long or short only: `extreme` is the high (long only) or low (short only) the next spike is measured from, and r1Pct the move from it. */
  gauge: { r1Pct: number | null; r3Pct: number | null; cooldownSec: number; extreme?: { kind: "high" | "low"; price: number } | null };
  open: { who: Who; side: Side; entry: number; size: number; adds: number; tp: number; sl: number; heldMin: number; unrealizedPct: number; unrealizedRoePct: number; unrealizedUsd: number; mfePct: number | null; maePct: number | null; manual: boolean }[];
  /** jev: Jev's own trades only; manual: the ones taken over or closed by hand (see isManual). */
  stats: Record<Who | "manual", Stat>;
  excursions: Record<Who, Excursion>;
  /** Newest first; `trade` is Jev's closed trade from that spike, if any. */
  spikes: (SpikeRow & { trade: Pick<TradeRow, "side" | "reason" | "pnlPct" | "roePct" | "pnlUsd"> | null; jevOpen: boolean })[];
  /** Cumulative USDT per strategy after each closed trade, oldest first. */
  curve: { ts: number; jev: number; fade: number; follow: number; manual: number }[];
}

export class SpikeTrader {
  readonly history: BlockEvent[] = [];
  onHalt: (reason: string) => void = () => {};
  /** Mid per tick with its block (a second), newest last; six minutes kept. */
  private hist: { b: number; mid: number }[] = [];
  private busy = false;
  private cooldownUntil = 0;
  private open = new Map<Who, Open>();
  private realized = 0; // Jev's closed trades, quote currency, fees included
  private feesUsd = 0;
  private closed = { jev: 0, fade: 0, follow: 0 };
  /** Everything in data/spike.jsonl, this run and earlier ones, for the dashboard. */
  private spikeRows: SpikeRow[] = [];
  private tradeRows: TradeRow[] = [];
  private lastMid = 0;
  private lastBlock = 0;
  private refreshedAt = Date.now();
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, skips: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, feesUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };
  /** Read each time: the settings panel can change the ROE targets while the bot runs. Open positions keep theirs. */
  private get tpPct() { return config.spike.takeProfitRoePct / config.okx.leverage; }
  private get slPct() { return config.spike.stopLossRoePct / config.okx.leverage; }

  /** Live: Jev's orders go to the exchange through this. Dry run: undefined, everything is simulated. */
  private readonly exec: MarketExec | undefined;
  private halted = false;
  private posCheckedAt = 0;

  constructor(
    private venue: Venue,
    private model: SpikeModel,
    private onEvent: (e: BlockEvent, note?: string) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
  ) {
    this.exec = venue.live ? venue.exec : undefined;
    if (venue.live && !this.exec) throw new Error("STRATEGY=spike live needs market execution (OKX)");
    mkdirSync("data", { recursive: true });
    // Only this coin's history, and only this mode's: a live run shows live records, a dry run dry-run ones.
    // Rows from before coins were recorded were all XRP-USDT-SWAP; from before modes were, all dry runs.
    const mine = (r: { instId?: string; live?: boolean }) => (r.instId ?? "XRP-USDT-SWAP") === venue.info.market && (r.live ?? false) === venue.live;
    if (existsSync(LOG)) for (const line of readFileSync(LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (!mine(r)) continue; if (r.type === "spike") this.spikeRows.push(r); else if (r.type === "trade") this.tradeRows.push(r); } catch {}
    }
  }

  /** For GET /spike: plan, how close the market is to a spike, open positions, and Jev vs the rules. */
  snapshot(): SpikeSnapshot {
    const mid = this.lastMid, now = this.lastBlock; // blocks are seconds
    const r = (sec: number) => { const then = this.midAgo(sec); return then && mid ? round((mid / then - 1) * 100, 3) : null; };
    const stat = (ts: TradeRow[]): Stat => {
      const by = (reason: string) => ts.filter((x) => x.reason === reason).length;
      return { trades: ts.length, wins: ts.filter((x) => x.pnlPct > 0).length, avgPct: ts.length ? round(ts.reduce((a, x) => a + x.pnlPct, 0) / ts.length, 4) : 0, totalUsd: round(ts.reduce((a, x) => a + x.pnlUsd, 0), 5), tp: by("take-profit"), sl: by("stop-loss"), time: by("time") };
    };
    const rowsOf = (who: Who) => this.tradeRows.filter((x) => x.who === who && !isManual(x));
    const stats = { jev: stat(rowsOf("jev")), fade: stat(rowsOf("fade")), follow: stat(rowsOf("follow")), manual: stat(this.tradeRows.filter(isManual)) };
    // The plan's own exits join the levels, so the table says how often they would have been reached.
    const levels = [...new Set([...REACH_LEVELS, round(this.tpPct, 2), round(this.slPct, 2)])].sort((a, b) => a - b);
    const excursion = (ts: TradeRow[]): Excursion => {
      const m = ts.filter((x) => x.mfePct !== undefined && x.maePct !== undefined);
      const avg = (f: (x: TradeRow) => number) => (m.length ? round(m.reduce((a, x) => a + f(x), 0) / m.length, 3) : 0);
      return {
        measured: m.length, mfeAvg: avg((x) => x.mfePct!), maeAvg: avg((x) => x.maePct!),
        reach: levels.map((pct) => ({ pct, fav: m.filter((x) => x.mfePct! >= pct).length, adv: m.filter((x) => x.maePct! <= -pct).length })),
      };
    };
    const excursions = { jev: excursion(rowsOf("jev")), fade: excursion(rowsOf("fade")), follow: excursion(rowsOf("follow")) };
    const jevBySpike = new Map(this.tradeRows.filter((x) => x.who === "jev").map((x) => [x.spikeBlock, x]));
    const jevOpen = this.open.get("jev");
    const cum = { jev: 0, fade: 0, follow: 0, manual: 0 };
    const curve = [...this.tradeRows].sort((a, b) => a.closedAt - b.closedAt).map((x) => {
      cum[isManual(x) ? "manual" : x.who] += x.pnlUsd;
      return { ts: x.ts ?? x.closedAt * 1000, jev: round(cum.jev, 5), fade: round(cum.fade, 5), follow: round(cum.follow, 5), manual: round(cum.manual, 5) };
    });
    return {
      plan: { live: this.venue.live, observe: this.venue.live && !!config.spike.observe, sides: config.spike.sides === 1 ? "long" : config.spike.sides === 2 ? "short" : "both", maxAdds: config.spike.maxAdds, allowReverse: !!config.spike.allowReverse, move1mPct: config.spike.move1mPct, move3mPct: config.spike.move3mPct, window1Sec: config.spike.window1Sec, window2Sec: config.spike.window2Sec, takeProfitRoePct: config.spike.takeProfitRoePct, stopLossRoePct: config.spike.stopLossRoePct, takeProfitPct: this.tpPct, stopLossPct: this.slPct, leverage: config.okx.leverage, maxHoldMin: config.spike.maxHoldMin, size: config.tradeSize, base: this.venue.info.base },
      gauge: this.extreme && mid
        ? { r1Pct: round((mid / this.extreme.price - 1) * 100, 3), r3Pct: null, cooldownSec: Math.max(0, this.cooldownUntil - now), extreme: this.extreme }
        : { r1Pct: r(config.spike.window1Sec), r3Pct: r(config.spike.window2Sec), cooldownSec: Math.max(0, this.cooldownUntil - now), extreme: null },
      open: [...this.open.values()].map((o) => {
        const dir = o.side === "buy" ? 1 : -1, u = mid ? dir * (mid / o.entry - 1) * 100 : 0;
        return { who: o.who, side: o.side, entry: o.entry, size: o.size, adds: o.adds, tp: o.tp, sl: o.sl, heldMin: round((now - o.openedAt) / 60, 1), unrealizedPct: round(u, 3), unrealizedRoePct: round(u * config.okx.leverage, 2), unrealizedUsd: round(mid ? dir * (mid - o.entry) * o.size : 0, 4), mfePct: o.mfe === undefined ? null : round(o.mfe, 3), maePct: o.mae === undefined ? null : round(o.mae, 3), manual: !!o.manual };
      }),
      stats,
      excursions,
      spikes: this.spikeRows.slice(-50).reverse().map((s) => {
        const tr = jevBySpike.get(s.block);
        return { ...s, trade: tr ? { side: tr.side, reason: tr.reason, pnlPct: tr.pnlPct, roePct: tr.roePct, pnlUsd: tr.pnlUsd } : null, jevOpen: !!jevOpen && jevOpen.spikeBlock === s.block };
      }),
      curve,
    };
  }

  describe() {
    const s = config.spike;
    return `spike · trigger ${s.move1mPct}% in ${spanLabel(s.window1Sec)} or ${s.move3mPct}% in ${spanLabel(s.window2Sec)} · exits ROE +${s.takeProfitRoePct}% / -${s.stopLossRoePct}% at ${config.okx.leverage}x = price +${this.tpPct}% / -${this.slPct}% · max ${s.maxHoldMin} min · shadows: fade, follow · log data/spike.jsonl`;
  }

  async onBlock(block: number) {
    if (this.halted) return;
    this.totals.blocks++;
    // The spike strategy reads prints through summary(); drain the push buffers so they do not grow.
    this.venue.trades.drainPrints(); this.venue.trades.drainFills();
    if (Date.now() - this.refreshedAt > 60_000) { this.refreshedAt = Date.now(); this.venue.refresh().catch(() => {}); }
    if (this.busy) { this.totals.lateBlocks++; return; }
    this.busy = true;
    try {
      const book = await this.venue.readBook();
      this.lastMid = book.mid;
      this.lastBlock = block;
      this.hist.push({ b: block, mid: book.mid });
      const keep = Math.max(config.spike.window1Sec, config.spike.window2Sec, 300) + 60;
      while (this.hist.length && this.hist[0]!.b < block - keep) this.hist.shift();
      let quote: Quote | null = null, fill: Fill | null = null, decision: Decision | null = null, note = "";
      for (const o of this.open.values()) this.excursion(o, book.mid);

      // Live: match the exchange first (exits that fired there, trades made in the OKX app).
      if (this.exec) {
        const res = await this.syncPosition(book, block);
        if (res) {
          ({ quote, fill } = res);
          const sg = (n: number, d: number) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
          const o = this.open.get("jev");
          note = res.reason === "manual-add" ? `MANUAL add: position now ${o?.size} at ${o?.entry}`
            : res.reason === "manual-open" ? `MANUAL position taken over: ${o?.side === "buy" ? "long" : "short"} ${o?.size} at ${o?.entry}`
            : `EXIT ${res.reason} ${sg(res.pnlPct, 3)}% (ROE ${(res.pnlPct * config.okx.leverage).toFixed(1)}%, ${sg(res.pnlUsd, 4)} ${this.venue.info.quoteCcy})${o ? `, ${o.size} left open` : ""}`;
        }
      }

      // Exits, for Jev and the shadows.
      for (const o of [...this.open.values()]) {
        if (o.who === "jev" && this.exec) {
          const res = await this.liveExit(o, book, block);
          if (res) { ({ quote, fill } = res); note = `EXIT ${res.reason} ${res.pnlPct >= 0 ? "+" : ""}${res.pnlPct.toFixed(3)}% (ROE ${(res.pnlPct * config.okx.leverage).toFixed(1)}%, ${res.pnlUsd >= 0 ? "+" : ""}${res.pnlUsd.toFixed(4)} ${this.venue.info.quoteCcy})`; }
          continue;
        }
        const r = this.exitReason(o, book, block);
        if (!r) continue;
        const res = this.close(o, book, block, r);
        if (o.who === "jev") { ({ quote, fill } = res); note = `EXIT ${r} ${res.pnlPct >= 0 ? "+" : ""}${res.pnlPct.toFixed(3)}% (ROE ${(res.pnlPct * config.okx.leverage).toFixed(1)}%)`; }
      }

      // Live: the session stop and take-profit (RISK_SESSION_*) close Jev's position and end the run.
      const halt = this.exec ? this.sessionLimit(book) : null;
      if (halt) {
        const o = this.open.get("jev");
        if (o) { const res = await this.liveClose(o, block, halt); ({ quote, fill } = res); }
        this.halted = true;
        note = `${halt}: session P&L ${this.sessionPnl(book).toFixed(4)} ${this.venue.info.quoteCcy}, position closed, stopping`;
        this.emit(block, book, null, quote, fill, note);
        this.onHalt(halt);
        return;
      }

      this.trackExtreme(book.mid);
      const spike = block >= this.cooldownUntil ? this.detect(book) : null;
      if (spike) {
        if (this.extreme) this.extreme = { kind: this.extreme.kind, price: book.mid }; // measure the next one from here
        this.cooldownUntil = block + config.spike.cooldownSec;
        const followSide: Side = spike.direction === "up" ? "buy" : "sell";
        const fadeSide: Side = followSide === "buy" ? "sell" : "buy";
        // The rules act on every spike, by the same add / reverse rules as Jev.
        for (const [who, side] of [["fade", fadeSide], ["follow", followSide]] as const) this.act(who, side, book, block);
        // Jev is asked when flat, or in a position when adding or reversing is allowed.
        const inPos = this.open.has("jev");
        let effect: Effect = "not-asked";
        if (!inPos || config.spike.maxAdds > 0 || config.spike.allowReverse) {
          decision = await this.model.decide(this.state(book, spike));
          this.totals.decisions++;
          this.totals.jevUsd += (decision.inputTokens / 1e6) * config.jevUsdPerMTok;
          const want = decision.action === "hold" ? null : decision.action;
          // Observing (live): Jev's call is recorded, nothing is sent.
          const observing = !!this.exec && !!config.spike.observe;
          const r = observing ? { effect: (want ? "observed" : inPos ? "hold" : "out") as Effect, quote: null, fill: null }
            : this.exec ? await this.liveAct(want, book, block) : this.act("jev", want, book, block);
          effect = r.effect;
          if (r.quote) ({ quote, fill } = r as { quote: Quote; fill: Fill | null });
          if (effect === "out" || effect === "hold") this.totals.skips++;
          const style = decision.action === "hold" ? "" : decision.action === followSide ? " (follow)" : " (fade)";
          note = `SPIKE ${spike.direction} ${spike.movePct.toFixed(2)}% in ${spike.window} -> ${decision.action === "hold" ? "stay out" : decision.action}${style}: ${effect}${"exitPct" in r && r.exitPct !== undefined ? ` (closed ${r.exitPct >= 0 ? "+" : ""}${r.exitPct.toFixed(3)}%)` : ""}${observing ? " (observing: no order)" : ""}`;
        } else note = `SPIKE ${spike.direction} ${spike.movePct.toFixed(2)}% in ${spike.window} (in a position: not asked)`;
        const row: SpikeRow = { type: "spike", instId: this.venue.info.market, live: this.venue.live, block, ts: Date.now(), window: spike.window, direction: spike.direction, movePct: spike.movePct, mid: book.mid, asked: !!decision, effect, jev: decision && { action: decision.action, probabilities: decision.probabilities, latencyMs: Math.round(decision.latencyMs) } };
        this.spikeRows.push(row);
        this.log(row);
      }
      this.emit(block, book, decision, quote, fill, note);
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** The mid `sec` seconds before the newest sample (the last one at or before then), or null without that much history. */
  private midAgo(sec: number): number | null {
    const h = this.hist, target = this.lastBlock - sec;
    if (!h.length || h[0]!.b > target) return null;
    for (let i = h.length - 1; i >= 0; i--) if (h[i]!.b <= target) return h[i]!.mid;
    return null;
  }

  /**
   * Take the current mid as the reference for both windows: moves already made are ignored and the next spike
   * is measured from here. Detection goes on at once (no waiting for history); real samples take over as they
   * age past each window. Returns the reference price.
   */
  resetReference(): number {
    const mid = this.lastMid;
    if (!mid) return 0;
    // One sample exactly a long window back (inside what onBlock keeps), one now: every window reads `mid`.
    const back = Math.max(config.spike.window1Sec, config.spike.window2Sec);
    this.hist = [{ b: this.lastBlock - back, mid }, { b: this.lastBlock, mid }];
    if (this.extreme) this.extreme = { kind: this.extreme.kind, price: mid };
    console.log(`spike reference reset to ${mid} at block ${this.lastBlock}`);
    return mid;
  }

  /**
   * Long only: the reference is the highest mid since the last spike or reset (each new high replaces it).
   * Short only: the lowest. Both sides: none (the windows decide). A change of sides starts it at the mid now.
   */
  private extreme: { kind: "high" | "low"; price: number } | null = null;
  private extremeFor = 0;
  private trackExtreme(mid: number) {
    const sides = config.spike.sides;
    if (sides !== this.extremeFor) {
      this.extremeFor = sides;
      this.extreme = sides === 1 ? { kind: "high", price: mid } : sides === 2 ? { kind: "low", price: mid } : null;
      if (this.extreme) console.log(`spike reference: ${this.extreme.kind} from ${mid}`);
      return;
    }
    if (!this.extreme) return;
    if (this.extreme.kind === "high" ? mid > this.extreme.price : mid < this.extreme.price) this.extreme = { kind: this.extreme.kind, price: mid };
  }

  /** Before the coin changes: close every position (Jev's at market when live) with reason "switch" so it is recorded. */
  async closeAllForSwitch() {
    await this.closeAll("switch");
  }

  /** On shutdown: never leave a live position behind. Closes Jev's at market (reason "shutdown") and the shadows. */
  async shutdown() {
    this.halted = true;
    await this.closeAll("shutdown");
  }

  private async closeAll(reason: string) {
    if (!this.open.size) return;
    const book = await this.venue.readBook();
    for (const o of [...this.open.values()]) {
      if (o.who === "jev" && this.exec) await this.liveClose(o, this.lastBlock, reason).catch((e) => console.error(`close on ${reason} failed: ${(e as Error).message}. Close it on OKX.`));
      else this.close(o, book, this.lastBlock, reason);
    }
  }

  // ---- live execution (Jev only; the fade and follow shadows stay simulated) ----

  /** P&L of this run for Jev, at mid: closed trades (fees included) and the open position. */
  private sessionPnl(book: Book) {
    const o = this.open.get("jev");
    return this.realized + (o ? (o.side === "buy" ? 1 : -1) * (book.mid - o.entry) * o.size : 0);
  }

  private sessionLimit(book: Book): string | null {
    const r = config.risk, pnl = this.sessionPnl(book);
    if (r.sessionStopLoss > 0 && pnl <= -r.sessionStopLoss) return "session-stop";
    if (r.sessionTakeProfit > 0 && pnl >= r.sessionTakeProfit) return "session-take";
    return null;
  }

  /** act() for Jev when live: the same decisions, sent to the exchange. */
  private async liveAct(want: Side | null, book: Book, block: number): Promise<{ effect: Effect; quote: Quote | null; fill: Fill | null; exitPct?: number }> {
    const o = this.open.get("jev");
    if (want && !allowedSides().includes(want)) want = null;
    if (!want) return { effect: o ? "hold" : "out", quote: null, fill: null };
    const affordable = this.venue.canAfford(want, config.tradeSize, book);
    if (!o) {
      if (!affordable) { console.warn("spike: not enough margin to open"); return { effect: "out", quote: null, fill: null }; }
      return { effect: "open", ...(await this.liveOpen(want, block)) };
    }
    if (o.side === want) {
      if (o.adds >= config.spike.maxAdds) return { effect: "hold", quote: null, fill: null };
      if (!affordable) { console.warn("spike: not enough margin to add"); return { effect: "hold", quote: null, fill: null }; }
      return { effect: "add", ...(await this.liveAdd(o, block)) };
    }
    if (!config.spike.allowReverse) return { effect: "hold", quote: null, fill: null };
    const exitPct = (await this.liveClose(o, block, "reverse")).pnlPct;
    return { effect: "reverse", ...(await this.liveOpen(want, block)), exitPct };
  }

  private async liveOpen(side: Side, block: number) {
    const r = await this.exec!.marketOrder(side, config.tradeSize, false);
    this.ownOrders.add(r.ordId);
    const dir = side === "buy" ? 1 : -1;
    const o: Open = { who: "jev", side, entry: r.avgPx, size: r.size, adds: 0, openedAt: block, spikeBlock: block, openedTs: Date.now() - 1000, tp: r.avgPx * (1 + (dir * this.tpPct) / 100), sl: r.avgPx * (1 - (dir * this.slPct) / 100) };
    o.entryFees = r.fee;
    this.open.set("jev", o);
    this.feesUsd += r.fee; this.realized -= r.fee;
    o.exitsOnExchange = await this.exec!.setExits({ side, tp: o.tp, sl: o.sl });
    return this.orderEvent(side, r.avgPx, r.size, r.fee, r.ordId, block);
  }

  private async liveAdd(o: Open, block: number) {
    const r = await this.exec!.marketOrder(o.side, config.tradeSize, false);
    this.ownOrders.add(r.ordId);
    const pos = await this.exec!.positionNow();
    const dir = o.side === "buy" ? 1 : -1;
    o.entry = pos.avgPx || (o.entry * o.size + r.avgPx * r.size) / (o.size + r.size);
    o.size = Math.abs(pos.size) || o.size + r.size;
    o.adds++;
    o.entryFees = (o.entryFees ?? 0) + r.fee;
    o.tp = o.entry * (1 + (dir * this.tpPct) / 100);
    o.sl = o.entry * (1 - (dir * this.slPct) / 100);
    this.feesUsd += r.fee; this.realized -= r.fee;
    o.exitsOnExchange = await this.exec!.setExits({ side: o.side, tp: o.tp, sl: o.sl });
    return this.orderEvent(o.side, r.avgPx, r.size, r.fee, r.ordId, block);
  }

  /** Close Jev's position at market (reduce-only), taking the exits off the exchange first. */
  private async liveClose(o: Open, block: number, reason: string) {
    await this.exec!.setExits(null);
    const side: Side = o.side === "buy" ? "sell" : "buy";
    const r = await this.exec!.marketOrder(side, o.size, true);
    this.ownOrders.add(r.ordId);
    const res = this.record(o, r.avgPx, r.fee, reason, block);
    return { ...res, ...this.orderEvent(side, r.avgPx, r.size, r.fee, r.ordId, block, reason) };
  }

  /**
   * Each tick while Jev holds a position: every 2 s the exchange's position is compared with the bot's (see
   * syncPosition: the OCO may have fired, or someone traded in the OKX app). Then the time limit, and the
   * take-profit / stop when they are not on the exchange.
   */
  private async liveExit(o: Open, book: Book, block: number) {
    const r = this.exitReason(o, book, block);
    if (!r || (r !== "time" && o.exitsOnExchange)) return null;
    const res = await this.liveClose(o, block, r);
    return { ...res, reason: r };
  }

  /** Orders the bot placed itself: their fills are booked when placed, so the sync skips them. */
  private ownOrders = new Set<string>();
  /** Fills the sync has booked already (by id). */
  private bookedFills = new Set<string>();
  /** The exchange size of the last check that disagreed with the bot: acted on only when the next check agrees. */
  private mismatch: number | null = null;

  /**
   * Every 2 s (live): make the bot's position match the exchange's, which is the truth. A difference must show
   * on two checks in a row (the exchange's position can lag an order by a moment). Then:
   * - closed on the exchange: booked from the real fills, as "take-profit" / "stop-loss" if our OCO fired,
   *   "manual" otherwise (closed in the OKX app);
   * - smaller: the part closed by hand is booked as its own "manual" trade, the rest stays open;
   * - bigger (bought more by hand): the position takes the exchange's size and average entry, exits move with it;
   * - the other side, or a position while the bot is flat: the bot's is booked "manual" and it takes over the
   *   one on the exchange, with its own take-profit, stop and time limit.
   * With the size unchanged, an OCO canceled by hand is placed again.
   */
  private async syncPosition(book: Book, block: number) {
    if (block - this.posCheckedAt < 2) return null;
    this.posCheckedAt = block;
    const exec = this.exec!;
    const pos = await exec.positionNow();
    let o = this.open.get("jev");
    const mine = o ? (o.side === "buy" ? 1 : -1) * o.size : 0;
    const eps = 1e-9 * Math.max(1, Math.abs(pos.size), Math.abs(mine));
    if (Math.abs(pos.size - mine) <= eps) {
      this.mismatch = null;
      if (o?.exitsOnExchange && exec.exitsState && (await exec.exitsState()) === "gone") {
        console.warn("spike: the take-profit / stop were canceled on the exchange; placing them again");
        o.exitsOnExchange = await exec.setExits({ side: o.side, tp: o.tp, sl: o.sl });
      }
      return null;
    }
    if (this.mismatch === null || Math.abs(this.mismatch - pos.size) > eps) { this.mismatch = pos.size; return null; }
    this.mismatch = null;

    let res: { quote: Quote; fill: Fill; pnlPct: number; pnlUsd: number; reason: string } | null = null;
    const sameSide = o && pos.size !== 0 && Math.sign(pos.size) === Math.sign(mine);
    if (o && sameSide && Math.abs(pos.size) > o.size) {
      // Bought more by hand: the exchange's size and average entry, exits moved to it.
      const qty = Math.abs(pos.size) - o.size;
      const f = await this.outsideFills(o.side, qty, o.openedTs ?? 0, book);
      const dir = o.side === "buy" ? 1 : -1;
      o.size = Math.abs(pos.size);
      o.entry = pos.avgPx || o.entry;
      o.manual = true; // part of it is no longer Jev's
      o.entryFees = (o.entryFees ?? 0) + f.fee;
      o.tp = o.entry * (1 + (dir * this.tpPct) / 100);
      o.sl = o.entry * (1 - (dir * this.slPct) / 100);
      this.feesUsd += f.fee; this.realized -= f.fee;
      o.exitsOnExchange = await exec.setExits({ side: o.side, tp: o.tp, sl: o.sl });
      console.log(`spike: ${qty} ${this.venue.info.base} added outside the bot; position now ${o.size} at ${o.entry}`);
      return { ...this.orderEvent(o.side, f.px, qty, f.fee, "manual", block), pnlPct: 0, pnlUsd: 0, reason: "manual-add" };
    }
    if (o) {
      // Closed (all or part), or turned to the other side: book what was closed.
      const closeSide: Side = o.side === "buy" ? "sell" : "buy";
      const qty = sameSide ? o.size - Math.abs(pos.size) : o.size;
      const state = sameSide ? null : exec.exitsState ? await exec.exitsState().catch(() => null) : undefined;
      // No exitsState (older exec): the level nearest the exit price says which fired.
      const f = await this.outsideFills(closeSide, qty, o.openedTs ?? 0, book);
      const reason = state === "tp" ? "take-profit" : state === "sl" ? "stop-loss" : state === undefined ? (Math.abs(f.px - o.tp) <= Math.abs(f.px - o.sl) ? "take-profit" : "stop-loss") : "manual";
      if (sameSide) {
        const part: Open = { ...o, size: qty, entryFees: ((o.entryFees ?? 0) * qty) / o.size };
        o.entryFees = (o.entryFees ?? 0) - part.entryFees!;
        o.size = Math.abs(pos.size);
        const r = this.record(part, f.px, f.fee, reason, block, true);
        console.log(`spike: ${qty} ${this.venue.info.base} closed outside the bot; ${o.size} left open`);
        return { ...r, reason, ...this.orderEvent(closeSide, f.px, qty, f.fee, "manual", block, reason) };
      }
      await exec.setExits(null);
      this.open.delete("jev");
      const r = this.record(o, f.px, f.fee, reason, block, true);
      res = { ...r, reason, ...this.orderEvent(closeSide, f.px, qty, f.fee, reason === "manual" ? "manual" : "exchange", block, reason) };
      o = undefined;
      if (pos.size === 0) return res;
    }
    // A position the bot does not hold (opened by hand, or what is left after turning): the bot takes it over.
    const side: Side = pos.size > 0 ? "buy" : "sell", dir = pos.size > 0 ? 1 : -1, size = Math.abs(pos.size);
    const entry = pos.avgPx || book.mid;
    const fee = config.spike.takerFeeRate * entry * size;
    // Adds counted as if it was built from orders of the current size: 40 at 10 a time is 1 + 3 adds.
    const adds = Math.max(0, Math.round(size / config.tradeSize) - 1);
    const n: Open = { who: "jev", side, entry, size, adds, openedAt: block, spikeBlock: -1, openedTs: Date.now() - 1000, entryFees: fee, manual: true, tp: entry * (1 + (dir * this.tpPct) / 100), sl: entry * (1 - (dir * this.slPct) / 100) };
    this.open.set("jev", n);
    this.feesUsd += fee; this.realized -= fee;
    n.exitsOnExchange = await exec.setExits({ side, tp: n.tp, sl: n.sl });
    console.log(`spike: took over a ${side === "buy" ? "long" : "short"} of ${size} ${this.venue.info.base} at ${entry} opened outside the bot`);
    return res ?? { ...this.orderEvent(side, entry, size, fee, "manual", block), pnlPct: 0, pnlUsd: 0, reason: "manual-open" };
  }

  /**
   * The newest fills on `side` from orders the bot did not place, not booked yet, adding up to `qty`: average
   * price and fees. Marks them booked. Without such fills (not listed yet), the mid and the taker fee.
   */
  private async outsideFills(side: Side, qty: number, sinceMs: number, book: Book) {
    const all = await this.exec!.fillsSince(sinceMs, side).catch(() => []);
    const key = (f: (typeof all)[number]) => f.id ?? `${f.ts}:${f.px}:${f.size}`;
    let got = 0, px = 0, fee = 0;
    for (const f of all.filter((f) => !(f.ordId && this.ownOrders.has(f.ordId)) && !this.bookedFills.has(key(f))).reverse()) {
      if (got >= qty - 1e-9) break;
      const take = Math.min(f.size, qty - got);
      px += f.px * take; fee += (f.fee * take) / f.size; got += take;
      this.bookedFills.add(key(f));
    }
    if (got < qty - 1e-9) {
      const rest = qty - got;
      px += book.mid * rest; fee += config.spike.takerFeeRate * book.mid * rest;
    }
    return { px: px / qty, fee };
  }

  /** Update the position's best and worst move from its entry (price %, + in its favour) with the mid now. */
  private excursion(o: Open, mid: number) {
    const move = (o.side === "buy" ? 1 : -1) * (mid / o.entry - 1) * 100;
    o.mfe = Math.max(o.mfe ?? move, move);
    o.mae = Math.min(o.mae ?? move, move);
  }

  /** The row fields for how far the position went, rounded; none if it never saw a tick. */
  private excursionFields(o: Open) {
    return o.mfe === undefined || o.mae === undefined ? {} : { mfePct: round(o.mfe, 3), maePct: round(o.mae, 3) };
  }

  /** Book a closed Jev position at `exit` with the exit fee: the trade row, realized P&L and fees. */
  private record(o: Open, exit: number, exitFee: number, reason: string, block: number, alreadyRemoved = false) {
    if (!alreadyRemoved) this.open.delete(o.who);
    const dir = o.side === "buy" ? 1 : -1;
    const gross = dir * (exit - o.entry) * o.size;
    const entryFees = o.entryFees ?? config.spike.takerFeeRate * o.entry * o.size; // what the exchange charged on entry
    const pnlUsd = gross - exitFee - entryFees;
    const pnlPct = (pnlUsd / (o.entry * o.size)) * 100;
    this.closed[o.who]++;
    const row: TradeRow = { type: "trade", instId: this.venue.info.market, live: this.venue.live, who: o.who, side: o.side, spikeBlock: o.spikeBlock, openedAt: o.openedAt, closedAt: block, heldMin: round((block - o.openedAt) / 60, 1), entry: o.entry, exit, size: o.size, adds: o.adds, reason, pnlPct: round(pnlPct, 4), roePct: round(pnlPct * config.okx.leverage, 2), pnlUsd: round(pnlUsd, 5), ts: Date.now(), ...this.excursionFields(o), ...(o.who === "jev" ? { manual: !!o.manual || reason === "manual" } : {}) };
    this.tradeRows.push(row);
    this.log(row);
    this.feesUsd += exitFee;
    this.realized += gross - exitFee;
    return { pnlPct, pnlUsd };
  }

  /** The block event's quote and fill for a live order. */
  private orderEvent(side: Side, price: number, size: number, fee: number, ordId: string, block: number, reason?: string) {
    this.totals.quotes++; this.totals.fills++;
    const close = reason ? (reason === "take-profit" || reason === "session-take" ? "position-take" : "position-stop") : undefined;
    const quote: Quote = { side, price, size, txHash: null, ref: null, gasMon: 0, cancel: [], status: "placed", orderId: ordId, capped: false, ...(close ? { close } : {}) };
    const fill: Fill = { side, size, price, txHash: null, orderId: ordId, simulated: false, fee };
    return { quote, fill };
  }

  /**
   * A move of at least move1mPct over the short window or move3mPct over the long one, each needing that
   * much history. The windows can change while running (settings); the history keeps enough for either.
   */
  detect(book: Book): SpikeState["spike"] | null {
    // Long or short only: a pullback from the high (long) or a bounce from the low (short), of move1mPct.
    if (this.extreme) {
      const r = (book.mid / this.extreme.price - 1) * 100;
      const hit = this.extreme.kind === "high" ? r <= -config.spike.move1mPct : r >= config.spike.move1mPct;
      return hit ? { window: this.extreme.kind === "high" ? "from high" : "from low", direction: r > 0 ? "up" : "down", movePct: round(r, 3), fromPrice: this.extreme.price } : null;
    }
    const { window1Sec: w1, window2Sec: w2 } = config.spike;
    const m1 = this.midAgo(w1), m2 = this.midAgo(w2);
    const r1 = m1 === null ? 0 : (book.mid / m1 - 1) * 100, r2 = m2 === null ? 0 : (book.mid / m2 - 1) * 100;
    if (m1 !== null && Math.abs(r1) >= config.spike.move1mPct) return { window: spanLabel(w1), direction: r1 > 0 ? "up" : "down", movePct: round(r1, 3), fromPrice: m1 };
    if (m2 !== null && Math.abs(r2) >= config.spike.move3mPct) return { window: spanLabel(w2), direction: r2 > 0 ? "up" : "down", movePct: round(r2, 3), fromPrice: m2 };
    return null;
  }

  private state(book: Book, spike: SpikeState["spike"]): SpikeState {
    const { priceDecimals: pd, sizeDecimals: sd } = this.venue.info;
    const ret = (sec: number) => { const then = this.midAgo(sec); return then ? round((book.mid / then - 1) * 100, 3) : 0; };
    // The mid every 10 s over the last 5 minutes, whatever the tick.
    const path: number[] = [];
    for (let sec = 300; sec >= 0; sec -= 10) { const v = sec ? this.midAgo(sec) : book.mid; if (v !== null) path.push(v); }
    const lvl = (l: [number, number]) => `${l[0].toFixed(pd)} x ${round(l[1], sd)}`;
    const depth: SpikeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, sd), ask: round(v.ask, sd) };
    const s = this.venue.trades.summary(Math.max(config.spike.window1Sec, config.spike.window2Sec), this.lastBlock);
    return {
      market: this.venue.info.symbol, mid: book.mid, spreadBps: round(book.spreadBps, 2), spike,
      returnsPct: { last1m: ret(60), last3m: ret(180), last5m: ret(300) },
      recentMids: path.map((x) => x.toFixed(pd + 1)).join(" "),
      bookImbalance: round(book.imbalance, 3), depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      trades: { count: s.count, buyMon: round(s.buyMon, sd), sellMon: round(s.sellMon, sd), cvdMon: round(s.cvdMon, sd), vwap: s.vwap, lastSide: s.lastSide },
      recentTrades: this.venue.trades.recent(10).map((x) => `${x.side} ${round(x.size, sd)} @ ${x.price.toFixed(pd)}`),
      plan: { leverage: config.okx.leverage, takeProfitPct: this.tpPct, stopLossPct: this.slPct, takeProfitRoePct: config.spike.takeProfitRoePct, stopLossRoePct: config.spike.stopLossRoePct, maxHoldMin: config.spike.maxHoldMin, takerFeeBps: round(config.spike.takerFeeRate * 10_000, 2), maxAdds: config.spike.maxAdds, canReverse: !!config.spike.allowReverse },
      fundingRatePct: this.venue.extras?.().fundingRatePct ?? null,
      position: this.positionState(book),
    };
  }

  /** Jev's position as the question shows it, or null when flat. */
  private positionState(book: Book): SpikeState["position"] {
    const o = this.open.get("jev");
    if (!o) return null;
    const dir = o.side === "buy" ? 1 : -1, u = dir * (book.mid / o.entry - 1) * 100;
    return { side: dir > 0 ? "long" : "short", sizeMon: o.size, entry: o.entry, adds: o.adds, addsLeft: Math.max(0, config.spike.maxAdds - o.adds), heldMin: round((this.lastBlock - o.openedAt) / 60, 1), unrealizedRoePct: round(u * config.okx.leverage, 2) };
  }

  /**
   * What one strategy does with a spike, given the side it wants (null: stay out). Flat: open. Same side:
   * add while adds are left (SPIKE_MAX_ADDS), else hold. Other side: close and open the other way when
   * SPIKE_ALLOW_REVERSE, else hold. Returns the effect and, for Jev, the order this block shows.
   */
  act(who: Who, want: Side | null, book: Book, block: number): { effect: Effect; quote: Quote | null; fill: Fill | null; exitPct?: number } {
    const o = this.open.get(who);
    if (want && !allowedSides().includes(want)) want = null; // a side not allowed now counts as staying out
    if (!want) return { effect: o ? "hold" : "out", quote: null, fill: null };
    if (!o) return { effect: "open", ...this.openPos(who, want, book, block) };
    if (o.side === want) {
      if (o.adds >= config.spike.maxAdds) return { effect: "hold", quote: null, fill: null };
      return { effect: "add", ...this.addTo(o, book, block) };
    }
    if (!config.spike.allowReverse) return { effect: "hold", quote: null, fill: null };
    const exitPct = this.close(o, book, block, "reverse").pnlPct;
    return { effect: "reverse", ...this.openPos(who, want, book, block), exitPct };
  }

  /** One more order on the position's side at market: the entry becomes the size-weighted average, exits move with it. */
  private addTo(o: Open, book: Book, block: number) {
    const price = o.side === "buy" ? book.ask : book.bid, add = config.tradeSize, dir = o.side === "buy" ? 1 : -1;
    o.entry = (o.entry * o.size + price * add) / (o.size + add);
    o.size += add;
    o.adds++;
    o.tp = o.entry * (1 + (dir * this.tpPct) / 100);
    o.sl = o.entry * (1 - (dir * this.slPct) / 100);
    if (o.who !== "jev") return { quote: null, fill: null };
    const fee = add * price * config.spike.takerFeeRate;
    this.feesUsd += fee;
    this.realized -= fee;
    this.totals.quotes++; this.totals.fills++;
    const quote: Quote = { side: o.side, price, size: add, txHash: null, ref: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false };
    const fill: Fill = { side: o.side, size: add, price, txHash: null, orderId: -block, simulated: true, fee };
    return { quote, fill };
  }

  /** Market entry, simulated at the touch: a buy pays the ask, a sell gets the bid. */
  private openPos(who: Who, side: Side, book: Book, block: number) {
    const entry = side === "buy" ? book.ask : book.bid, size = config.tradeSize;
    const dir = side === "buy" ? 1 : -1;
    const o: Open = { who, side, entry, size, adds: 0, openedAt: block, spikeBlock: block, tp: entry * (1 + (dir * this.tpPct) / 100), sl: entry * (1 - (dir * this.slPct) / 100) };
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
    if (block - o.openedAt >= config.spike.maxHoldMin * 60) return "time";
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
    const row: TradeRow = { type: "trade", instId: this.venue.info.market, live: this.venue.live, who: o.who, side: o.side, spikeBlock: o.spikeBlock, openedAt: o.openedAt, closedAt: block, heldMin: round((block - o.openedAt) / 60, 1), entry: o.entry, exit, size: o.size, adds: o.adds, reason, pnlPct: round(pnlPct, 4), roePct: round(pnlPct * config.okx.leverage, 2), pnlUsd: round(pnlUsd, 5), ts: Date.now(), ...this.excursionFields(o) };
    this.tradeRows.push(row);
    this.log(row);
    if (o.who !== "jev") return { quote: null, fill: null, pnlPct };
    const exitFee = config.spike.takerFeeRate * exit * o.size;
    this.feesUsd += exitFee;
    this.realized += dir * (exit - o.entry) * o.size - exitFee;
    this.totals.quotes++; this.totals.fills++;
    const side: Side = long ? "sell" : "buy";
    const quote: Quote = { side, price: exit, size: o.size, txHash: null, ref: null, gasMon: 0, cancel: [], status: "sim", orderId: null, capped: false, close: reason === "stop-loss" || reason === "reverse" ? "position-stop" : "position-take" };
    const fill: Fill = { side, size: o.size, price: exit, txHash: null, orderId: -block, simulated: true, fee: exitFee };
    return { quote, fill, pnlPct };
  }

  private log(row: object) {
    appendFileSync(LOG, JSON.stringify(row) + "\n");
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
