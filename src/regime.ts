/**
 * Step 1 of strategy selection: once a day (with the market brief) Jev is asked which strategy fits the market,
 * from the market's character and each strategy's results. Only a recommendation, reported to the coin-trade
 * office: nothing switches. Each one is kept in data/regime.jsonl, and the next day's brief says how the
 * strategies actually did, so whether the picks hold up can be judged before anything is automated.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";

const OKX = "https://www.okx.com";
const LOG = "data/regime.jsonl";

export const STRATEGIES = {
  spike_fade: { ko: "급변 되돌림", criteria: "Trade against sharp 3 to 5 minute moves: buy after a sudden drop, sell after a sudden spike up. Fits a choppy range where moves snap back." },
  band_reversion: { ko: "밴드 평균회귀", criteria: "Buy at the lower Bollinger band and sell at the upper band on 15-minute bars, exiting at the middle. Fits a steady sideways range." },
  squeeze_breakout: { ko: "스퀴즈 돌파", criteria: "Wait for the bands to get unusually narrow, then follow the break out of the range. Fits a market coiling before a big move." },
  trend_follow: { ko: "추세 추종", criteria: "Follow breaks of the 4-hour high or low with a trailing stop. Fits a market moving steadily in one direction." },
  stand_aside: { ko: "쉬기", criteria: "Do not open new trades: conditions are unclear or an event risk dominates." },
} as const;
export type StrategyKey = keyof typeof STRATEGIES;
/** Which strategies' trades show how a pick did (spike_fade: Jev's own trades and the fade rule). */
export const STRATEGY_WHO: Record<StrategyKey, string[]> = { spike_fade: ["jev", "fade"], band_reversion: ["band"], squeeze_breakout: ["squeeze"], trend_follow: ["trend"], stand_aside: [] };

export interface Regime {
  price: number; range7: [number, number]; width7Pct: number; posIn7: number; width14Pct: number;
  bbWidthPct: number; bbWidthPercentile: number; zVsMiddle: number; ema20: number; ema50: number; ema50Slope24hPct: number;
  efficiency48h: number; fundingPct: number; longShortRatio: number | null;
}

export interface Recommendation { date: string; ts: number; choice: StrategyKey; confidence: number; probabilities: Record<string, number>; crowded: number | null; regime: Regime }

async function okx<T>(path: string, q: Record<string, string>): Promise<T> {
  const j = (await (await fetch(`${OKX}${path}?${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(8000) })).json()) as { code: string; msg: string; data: T };
  if (j.code !== "0") throw new Error(`okx ${path}: ${j.code} ${j.msg}`);
  return j.data;
}

/** The market's character from OKX candles: range, trendiness, band width, positioning. */
export async function marketRegime(instId: string): Promise<Regime> {
  const coin = instId.split("-")[0]!;
  const [m15, h1, d1, [f], ls] = await Promise.all([
    okx<string[][]>("/api/v5/market/candles", { instId, bar: "15m", limit: "200" }),
    okx<string[][]>("/api/v5/market/candles", { instId, bar: "1H", limit: "200" }),
    okx<string[][]>("/api/v5/market/candles", { instId, bar: "1D", limit: "15" }),
    okx<{ fundingRate: string }[]>("/api/v5/public/funding-rate", { instId }),
    okx<string[][]>("/api/v5/rubik/stat/contracts/long-short-account-ratio", { ccy: coin, period: "1H" }).catch(() => [] as string[][]),
  ]);
  const c15 = m15.map((r) => Number(r[4])).reverse(), c1h = h1.map((r) => Number(r[4])).reverse();
  const days = d1.map((r) => ({ h: Number(r[2]), l: Number(r[3]) })).reverse();
  const band = (end: number) => { const w = c15.slice(end - 20, end), m = w.reduce((a, x) => a + x, 0) / 20, s = Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / 20); return { m, s, width: ((4 * s) / m) * 100 }; };
  const widths: number[] = []; for (let e = 20; e <= c15.length; e++) widths.push(band(e).width);
  const now = band(c15.length), price = c15[c15.length - 1]!;
  const ema = (xs: number[], n: number) => { const k = 2 / (n + 1); let e = xs[0]!; return xs.map((x) => (e = x * k + e * (1 - k))); };
  const e20 = ema(c1h, 20), e50 = ema(c1h, 50);
  const seg = c1h.slice(-49), net = Math.abs(seg[seg.length - 1]! - seg[0]!), path = seg.slice(1).reduce((a, x, i) => a + Math.abs(x - seg[i]!), 0);
  const week = days.slice(-7), hi7 = Math.max(...week.map((d) => d.h)), lo7 = Math.min(...week.map((d) => d.l));
  const hi14 = Math.max(...days.map((d) => d.h)), lo14 = Math.min(...days.map((d) => d.l));
  const r = (x: number, d = 2) => Number(x.toFixed(d));
  return {
    price, range7: [lo7, hi7], width7Pct: r((hi7 / lo7 - 1) * 100), posIn7: r((price - lo7) / (hi7 - lo7 || 1)), width14Pct: r((hi14 / lo14 - 1) * 100),
    bbWidthPct: r(now.width), bbWidthPercentile: Math.round((widths.filter((x) => x <= now.width).length / widths.length) * 100), zVsMiddle: r((price - now.m) / (now.s || 1)),
    ema20: r(e20[e20.length - 1]!, 4), ema50: r(e50[e50.length - 1]!, 4), ema50Slope24hPct: r((e50[e50.length - 1]! / e50[e50.length - 25]! - 1) * 100),
    efficiency48h: r(net / (path || 1)), fundingPct: r(Number(f?.fundingRate ?? 0) * 100, 4), longShortRatio: ls[0] ? r(Number(ls[0][1])) : null,
  };
}

/** Each strategy's results as one line for Jev, e.g. "31 trades, 48% wins, average +0.155% per trade". */
export type Results = Record<string, { trades: number; wins: number; avgPct: number }>;
const resultLine = (x?: { trades: number; wins: number; avgPct: number }) =>
  !x || !x.trades ? "no closed trades yet" : `${x.trades} trades, ${Math.round((x.wins / x.trades) * 100)}% wins, average ${x.avgPct >= 0 ? "+" : ""}${x.avgPct.toFixed(3)}% per trade`;

/** Ask Jev which strategy fits; null without the Jev model (MODEL=mock) or on an error. */
export async function recommend(instId: string, regime: Regime, results: Results): Promise<Recommendation | null> {
  if (config.model !== "jev") return null;
  const coin = instId.split("-")[0]!;
  const state = {
    market: `${coin}-USDT perpetual on OKX`,
    price: regime.price,
    range_7d: `${regime.range7[0]} to ${regime.range7[1]} (${regime.width7Pct}% wide); the price sits at ${Math.round(regime.posIn7 * 100)}% of it`,
    range_14d_width_pct: regime.width14Pct,
    bollinger_15m_width_pct: regime.bbWidthPct,
    bollinger_15m_width_percentile_of_last_180_bars: regime.bbWidthPercentile,
    price_vs_15m_middle_band_in_sigma: regime.zVsMiddle,
    ema20_1h: regime.ema20, ema50_1h: regime.ema50, ema50_change_over_24h_pct: regime.ema50Slope24hPct,
    efficiency_ratio_48h: `${regime.efficiency48h} (net move divided by total path; near 0 means choppy back-and-forth, near 1 a clean trend)`,
    funding_rate_pct_per_8h: regime.fundingPct,
    long_short_account_ratio: regime.longShortRatio,
    results_spike_fade_jev: resultLine(results.jev),
    results_spike_fade_rule: resultLine(results.fade),
    results_spike_follow_rule: resultLine(results.follow),
    results_trend_breakout_4h: resultLine(results.trend),
    results_band_reversion: resultLine(results.band),
    results_squeeze_breakout: resultLine(results.squeeze),
  };
  const questions = {
    strategy: {
      type: "choice",
      instructions: "Which trading strategy fits this market best for the next day?",
      criteria: Object.fromEntries(Object.entries(STRATEGIES).map(([k, v]) => [k, v.criteria])),
    },
    crowded: {
      type: "boolean", // the SDK's name for TypeSafe's yes/no (noul) question
      instructions: "Is one side of the market crowded enough that a sharp move against it is a significant risk?",
      criteria: { true: "Long/short ratio far from 1 (above 2.5 or below 0.4) or a funding rate far from zero.", false: "Positioning is roughly balanced." },
    },
  } as const;
  try {
    const r = await experimental_evaluate({ model: typeSafeAi.evaluationModel(config.jevModelId), state: state as any, questions: questions as any, maxRetries: 1 });
    const a = r.answers.strategy as { choice: string; confidence?: number; probabilities?: Record<string, number> };
    const c = r.answers.crowded as { probability?: number } | undefined;
    const rec: Recommendation = {
      date: new Date().toLocaleDateString("sv-SE"), ts: Date.now(), choice: a.choice as StrategyKey, confidence: (r as { confidence?: Record<string, number> }).confidence?.strategy ?? a.confidence ?? 0,
      probabilities: a.probabilities ?? { [a.choice]: 1 }, crowded: c?.probability ?? null, regime,
    };
    try { mkdirSync("data", { recursive: true }); appendFileSync(LOG, JSON.stringify(rec) + "\n"); } catch { /* reported anyway */ }
    return rec;
  } catch (e) {
    console.warn(`strategy recommendation: ${(e as Error).message}`);
    return null;
  }
}

/** The recommendations kept so far, oldest first. */
export function pastRecommendations(): Recommendation[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as Recommendation]; } catch { return []; } });
}

/** The recommendation as text for the brief (Korean, no middle dots or dashes). */
export function recommendationText(rec: Recommendation): string {
  const ranked = Object.entries(rec.probabilities).sort((a, b) => b[1] - a[1]);
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const others = ranked.filter(([k]) => k !== rec.choice).map(([k, p]) => `${STRATEGIES[k as StrategyKey]?.ko ?? k} ${pct(p)}`).join(", ");
  const crowded = rec.crowded === null ? "" : ` 한쪽 쏠림 위험: ${pct(rec.crowded)}.`;
  return `Jev 전략 추천: ${STRATEGIES[rec.choice]?.ko ?? rec.choice} ${pct(rec.probabilities[rec.choice] ?? rec.confidence)} (${others}).${crowded} 추천만 하고 전략은 바꾸지 않습니다.`;
}

/** How yesterday's pick did: each strategy's trades closed since it was made (text for the brief), or null. */
export function reviewText(prev: Recommendation, since: Results): string {
  const line = (k: StrategyKey) => {
    const whos = STRATEGY_WHO[k];
    if (!whos.length) return null;
    const n = whos.reduce((a, w) => a + (since[w]?.trades ?? 0), 0);
    if (!n) return `${STRATEGIES[k].ko} 거래 없음`;
    const avg = whos.reduce((a, w) => a + (since[w]?.avgPct ?? 0) * (since[w]?.trades ?? 0), 0) / n;
    return `${STRATEGIES[k].ko} ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}% (${n}건)`;
  };
  const parts = (Object.keys(STRATEGIES) as StrategyKey[]).map(line).filter(Boolean);
  return `지난 추천(${prev.date}): ${STRATEGIES[prev.choice]?.ko ?? prev.choice}. 그 뒤 전략별 평균 성적: ${parts.join(", ")}.`;
}
