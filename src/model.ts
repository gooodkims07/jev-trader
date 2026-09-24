import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { VenueInfo } from "./venue";

/** Models answer buy or sell. `hold` is a late block (no decision was made), or on OKX the model choosing to skip. */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: string; // "MON-USDC" on Kuru, "<COIN>-USDT PERP" on OKX; sizes below are in that base asset
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting base asset within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  allowed: { buy: boolean; sell: boolean };
  /** OKX only (Kuru's state is unchanged). Inputs look back this many blocks; the question is about `horizonBlocks`. */
  lookbackBlocks?: number;
  /** OKX only: our position now. capMon is the most we may hold either way. */
  position?: { side: "long" | "short" | "flat"; sizeMon: number; entry: number | null; unrealizedBps: number; capMon: number };
  /** OKX only: what a fill costs. fundingRatePct is per funding period; positive means longs pay shorts. */
  costs?: { makerFeeBps: number; fundingRatePct: number | null };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

/** Where the order goes, in the venue's own terms. Everything else in the question is shared. */
function goal(v: VenueInfo): string {
  if (v.name === "kuru") return "Make markets on MON-USDC on Kuru. Blocks are ~300 ms; `horizonBlocks` (~30 s) is the horizon. Every block one post-only limit order goes on the side you pick, just inside the touch, replacing the previous one. It never crosses, so we earn `spreadBps` rather than pay it. The cost is adverse selection: a taker fills us exactly when the market is about to run the other way. Pick the side whose inventory you want to be holding `horizonBlocks` from now.";
  // OKX: a USDT perpetual swap, where the model may also skip. See okxQuestions.
  return okxGoal(v);
}

const secs = (blocks: number, v: VenueInfo) => Math.round((blocks * v.blockMs) / 1000);
const tickLabel = (v: VenueInfo) => (v.blockMs >= 1000 ? `${v.blockMs / 1000} s` : `${v.blockMs} ms`);

function okxGoal(v: VenueInfo): string {
  return `Make markets on the ${v.base}-USDT perpetual swap on ${v.label}. Each block here is a ${tickLabel(v)} tick. Every tick you choose: post one post-only limit order just inside the touch, a bid or an ask, replacing the previous one; or skip, which takes our order off the book. A fill earns half of \`spreadBps\` against mid and pays \`costs.makerFeeBps\`. When the spread is one tick the fee is bigger than what the spread pays, so a fill only makes money if the price then moves our way by more than the fee within \`horizonBlocks\` (~${secs(config.horizonBlocks, v)} s). The main risk is adverse selection: takers hit our order exactly when the price is about to run through it. Skip whenever neither side is clearly worth more than the fee; skipping costs nothing.`;
}

/**
 * Jev's question for this venue. On Kuru it is exactly the MON-USDC text. For any other base asset,
 * "MON" in the prose becomes that asset, and a line says the `...Mon` state fields are in it too.
 * On OKX the question is about whether a fill beats the fee, and skip is a third answer.
 */
export function questions(v: VenueInfo) {
  const asset = (text: string) => (v.base === "MON" ? text : text.replace(/\bMON\b/g, v.base));
  const units = v.base === "MON" ? "" : ` Sizes and every field ending in \`Mon\` are in ${v.base}.`;
  if (v.name === "okx") return okxQuestions(v, units);
  return {
    direction: {
      type: "choice",
      instructions: {
        question: asset("Will MON be higher or lower than the current mid after `horizonBlocks` more blocks?"),
        goal: goal(v),
        timing: "The order rests on the book from the next block until it is replaced, cancelled or filled. It fills only when a taker crosses it: a bid is filled by a taker sell, an ask by a taker buy. Most blocks do not fill.",
        inputs: "Taker flow is the strongest signal: `trades.cvdMon` (taker buys minus taker sells over the horizon), `trades.lastSide` and `recentTrades` show who is hitting the book, and therefore who would hit us. `depth` and `book` show resting liquidity per side at several distances from mid; thin depth on one side means price moves easily that way. `returnsBps` and `recentMids` show the path over the horizon. A wide `spreadBps` means more edge per fill. If `allowed.buy` is false the order goes on the sell side regardless, and vice versa." + units,
      },
      criteria: {
        buy: asset("Post a bid: mid more likely to be higher after `horizonBlocks` blocks. A fill here leaves us long MON, bought below mid."),
        sell: asset("Post an ask: mid more likely to be lower after `horizonBlocks` blocks. A fill here leaves us short MON, sold above mid."),
      } as Record<string, string>,
    },
  } as const;
}

function okxQuestions(v: VenueInfo, units: string) {
  const b = v.base;
  return {
    direction: {
      type: "choice",
      instructions: {
        question: `Post a bid, post an ask, or skip this tick? Pick the side where a fill is most likely to be worth more than \`costs.makerFeeBps\` once \`horizonBlocks\` more blocks have passed, or skip if neither is.`,
        goal: okxGoal(v),
        timing: "The order rests on the book from the next block until it is replaced, cancelled or filled. It fills only when a taker crosses it: a bid is filled by a taker sell, an ask by a taker buy. Most ticks do not fill. Skipping cancels whatever we had resting.",
        inputs: `Taker flow shows who would hit us: \`trades.cvdMon\` (taker buys minus taker sells over \`lookbackBlocks\`), \`trades.lastSide\` and \`recentTrades\`. A taker selling into our bid is often the start of a move down; the fill is worth it only if the price comes back up past the fee. \`depth\` and \`book\` show resting liquidity per side; thin depth on one side means price moves easily that way. \`returnsBps\` and \`recentMids\` show the path over \`lookbackBlocks\`. \`position\` is ours now (${b}, average entry, unrealized bps; \`capMon\` is the most we may hold either way): a bid fill adds to a long or shrinks a short, an ask fill the opposite. \`costs.fundingRatePct\` is the funding rate per period; positive means longs pay shorts. If \`allowed.buy\` is false the order goes on the sell side regardless, and vice versa.${units}`,
      },
      criteria: {
        buy: `Post a bid: a taker sell filling it here is likely to be followed by the price rising more than the fee within \`horizonBlocks\` blocks. A fill leaves us longer ${b}, bought below mid.`,
        sell: `Post an ask: a taker buy filling it here is likely to be followed by the price falling more than the fee within \`horizonBlocks\` blocks. A fill leaves us shorter ${b}, sold above mid.`,
        hold: "Skip: neither side is likely to beat the fee after adverse selection. Our resting order is taken off the book and nothing new is posted.",
      } as Record<string, string>,
    },
  } as const;
}

/** Real Jev via the AI SDK. Swap-in is the MODEL env var. */
export class JevModel implements Model {
  readonly name = config.jevModelId;
  private model = typeSafeAi.evaluationModel(config.jevModelId);
  private questions: ReturnType<typeof questions>;

  constructor(venue: VenueInfo) {
    this.questions = questions(venue);
  }

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: this.questions, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0, hold = (p as Record<string, number>).hold ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + mean reversion toward flat. Skips near 50/50 where allowed. */
export class MockModel implements Model {
  readonly name = "mock";

  constructor(private readonly canSkip = false) {}

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // momentum + book imbalance + noise, pulled back toward flat so it trades both ways
    const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 1.5 + flow * 2 + this.noise(state.block);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const skip = this.canSkip && Math.abs(buy - 0.5) < 0.15;
    const probabilities = skip ? { buy: buy * 0.4, sell: (1 - buy) * 0.4, hold: 0.6 } : { buy, sell: 1 - buy, hold: 0 };
    const action: Action = skip ? "hold" : buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(block: number) {
    let h = block * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (venue: VenueInfo): Model => (config.model === "jev" ? new JevModel(venue) : new MockModel(venue.name === "okx"));
