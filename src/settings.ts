/**
 * Settings the dashboard can read, and change while the bot runs (GET / POST /settings).
 *
 * Only values that are read fresh on every use are editable: triggers, exits, sizes, stops. What is fixed at
 * startup (venue, instrument, leverage, strategy, tick, horizon) is shown read-only. DRY_RUN and API keys are
 * never exposed or editable here: going live stays a deliberate command-line act.
 *
 * Writes need ADMIN_TOKEN (server env) as a bearer token: the server is reachable from outside, and these
 * values move money on a live run. Without ADMIN_TOKEN the panel is read-only. Changes persist to
 * data/settings.json and are applied over .env at the next startup (applySavedSettings).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config";
import type { InstrumentChoice, Venue } from "./venue";

/** Exit code asking scripts/run.sh to start the bot again (it re-reads data/settings.json). */
export const RESTART_CODE = 75;

const FILE = "data/settings.json";

type Group = "clock" | "spike" | "size" | "risk" | "mm";
interface Def { key: string; group: Group; min: number; max: number; step: number; unit: string; get(): number; set(v: number): void; strategies: ("mm" | "spike")[]; options?: number[]; venues?: ("kuru" | "okx")[] }

/** Spike windows offered (seconds): 30 s to 15 min. */
export const WINDOW_OPTIONS = [30, 60, 120, 180, 300, 600, 900];

/** Trend shadow breakout lookbacks offered (seconds): 1 h to 24 h. */
export const TREND_LOOKBACK_OPTIONS = [3600, 7200, 14_400, 28_800, 43_200, 86_400];

/** Leverage offered (spike on OKX). A change applies to the next position; the open one keeps its own. */
export const LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 15, 20];

/** Tick lengths offered for OKX (ms). */
export const TICK_OPTIONS = [1000, 3000, 5000, 10_000, 15_000, 30_000, 60_000];

const DEFS: Def[] = [
  { key: "okx.tickMs", group: "clock", min: 1000, max: 60_000, step: 1000, unit: "ms", get: () => config.okx.tickMs, set: (v) => { config.okx.tickMs = v; }, strategies: ["mm", "spike"], options: TICK_OPTIONS, venues: ["okx"] },
  { key: "spike.window1Sec", group: "spike", min: 30, max: 900, step: 30, unit: "s", get: () => config.spike.window1Sec, set: (v) => { config.spike.window1Sec = v; }, strategies: ["spike"], options: WINDOW_OPTIONS },
  { key: "spike.move1mPct", group: "spike", min: 0.05, max: 10, step: 0.05, unit: "%", get: () => config.spike.move1mPct, set: (v) => { config.spike.move1mPct = v; }, strategies: ["spike"] },
  { key: "spike.window2Sec", group: "spike", min: 30, max: 900, step: 30, unit: "s", get: () => config.spike.window2Sec, set: (v) => { config.spike.window2Sec = v; }, strategies: ["spike"], options: WINDOW_OPTIONS },
  { key: "spike.move3mPct", group: "spike", min: 0.05, max: 20, step: 0.05, unit: "%", get: () => config.spike.move3mPct, set: (v) => { config.spike.move3mPct = v; }, strategies: ["spike"] },
  { key: "spike.takeProfitRoePct", group: "spike", min: 1, max: 500, step: 1, unit: "% ROE", get: () => config.spike.takeProfitRoePct, set: (v) => { config.spike.takeProfitRoePct = v; }, strategies: ["spike"] },
  { key: "spike.stopLossRoePct", group: "spike", min: 1, max: 500, step: 1, unit: "% ROE", get: () => config.spike.stopLossRoePct, set: (v) => { config.spike.stopLossRoePct = v; }, strategies: ["spike"] },
  { key: "spike.maxHoldMin", group: "spike", min: 1, max: 1440, step: 1, unit: "min", get: () => config.spike.maxHoldMin, set: (v) => { config.spike.maxHoldMin = v; }, strategies: ["spike"] },
  { key: "spike.sides", group: "spike", min: 0, max: 2, step: 1, unit: "sides", get: () => config.spike.sides, set: (v) => { config.spike.sides = v; }, strategies: ["spike"], options: [0, 1, 2] },
  { key: "spike.maxAdds", group: "spike", min: 0, max: 20, step: 1, unit: "count", get: () => config.spike.maxAdds, set: (v) => { config.spike.maxAdds = v; }, strategies: ["spike"], options: Array.from({ length: 21 }, (_, i) => i) },
  { key: "spike.allowReverse", group: "spike", min: 0, max: 1, step: 1, unit: "bool", get: () => config.spike.allowReverse, set: (v) => { config.spike.allowReverse = v; }, strategies: ["spike"], options: [0, 1] },
  { key: "spike.observe", group: "spike", min: 0, max: 1, step: 1, unit: "bool", get: () => config.spike.observe, set: (v) => { config.spike.observe = v; }, strategies: ["spike"], options: [0, 1], venues: ["okx"] },
  { key: "spike.trendLookbackSec", group: "spike", min: 3600, max: 86_400, step: 3600, unit: "s", get: () => config.spike.trendLookbackSec, set: (v) => { config.spike.trendLookbackSec = v; }, strategies: ["spike"], options: TREND_LOOKBACK_OPTIONS },
  { key: "spike.trendTrailPct", group: "spike", min: 0.2, max: 10, step: 0.1, unit: "%", get: () => config.spike.trendTrailPct, set: (v) => { config.spike.trendTrailPct = v; }, strategies: ["spike"] },
  { key: "okx.leverage", group: "risk", min: 1, max: 20, step: 1, unit: "x", get: () => config.okx.leverage, set: (v) => { config.okx.leverage = v; }, strategies: ["spike"], options: LEVERAGE_OPTIONS, venues: ["okx"] },
  { key: "spike.cooldownSec", group: "spike", min: 0, max: 3600, step: 10, unit: "s", get: () => config.spike.cooldownSec, set: (v) => { config.spike.cooldownSec = v; }, strategies: ["spike"] },
  { key: "tradeSize", group: "size", min: 0, max: 1e9, step: 1, unit: "base", get: () => config.tradeSize, set: (v) => { config.tradeSize = v; }, strategies: ["mm", "spike"] },
  { key: "maxPosition", group: "size", min: 0, max: 1e9, step: 1, unit: "base", get: () => config.maxPosition, set: (v) => { config.maxPosition = v; }, strategies: ["mm"] },
  { key: "minSideProb", group: "mm", min: 0, max: 1, step: 0.05, unit: "", get: () => config.minSideProb, set: (v) => { config.minSideProb = v; }, strategies: ["mm"] },
  { key: "risk.sessionStopLoss", group: "risk", min: 0, max: 1e6, step: 0.5, unit: "quote", get: () => config.risk.sessionStopLoss, set: (v) => { config.risk.sessionStopLoss = v; }, strategies: ["mm", "spike"] },
  { key: "risk.sessionTakeProfit", group: "risk", min: 0, max: 1e6, step: 0.5, unit: "quote", get: () => config.risk.sessionTakeProfit, set: (v) => { config.risk.sessionTakeProfit = v; }, strategies: ["mm", "spike"] },
  { key: "risk.manualMaxMarginPct", group: "risk", min: 5, max: 100, step: 5, unit: "%", get: () => config.risk.manualMaxMarginPct, set: (v) => { config.risk.manualMaxMarginPct = v; }, strategies: ["spike"], venues: ["okx"] },
  { key: "risk.manualDailyLossLimit", group: "risk", min: 0, max: 1e6, step: 1, unit: "quote", get: () => config.risk.manualDailyLossLimit, set: (v) => { config.risk.manualDailyLossLimit = v; }, strategies: ["spike"], venues: ["okx"] },
  { key: "risk.positionStopPct", group: "risk", min: 0, max: 100, step: 0.5, unit: "%", get: () => config.risk.positionStopPct, set: (v) => { config.risk.positionStopPct = v; }, strategies: ["mm"] },
  { key: "risk.positionTakePct", group: "risk", min: 0, max: 1000, step: 0.5, unit: "%", get: () => config.risk.positionTakePct, set: (v) => { config.risk.positionTakePct = v; }, strategies: ["mm"] },
  { key: "okx.emergencyStopPct", group: "risk", min: 0, max: 100, step: 0.5, unit: "%", get: () => config.okx.emergencyStopPct, set: (v) => { config.okx.emergencyStopPct = v; }, strategies: ["mm"], venues: ["okx"] },
];

/** Apply data/settings.json over the .env values. Call once at startup, before the venue starts. */
export function applySavedSettings() {
  if (!existsSync(FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, number> & { "okx.instId"?: string; sizesFor?: string };
    const applied: string[] = [];
    // The coin comes first: sizes are in it. Saved sizes count as chosen for a coin only if saved with it.
    if (typeof saved["okx.instId"] === "string" && /^[A-Z0-9]+-USDT-SWAP$/.test(saved["okx.instId"])) {
      config.okx.instId = saved["okx.instId"];
      applied.push(`okx.instId=${config.okx.instId}`);
    }
    if (saved.sizesFor && saved.sizesFor === config.okx.instId) config.sizesSetForAnyCoin = true;
    for (const d of DEFS) {
      const v = saved[d.key];
      if (typeof v !== "number" || v < d.min || v > d.max || (d.options && !d.options.includes(v))) continue;
      d.set(v); applied.push(`${d.key}=${v}`);
    }
    if (applied.length) console.log(`settings from ${FILE}: ${applied.join(" ")}`);
  } catch (e) {
    console.warn(`${FILE}: ${(e as Error).message}; ignored`);
  }
}

export function tokenOk(req: Request) {
  const want = config.adminToken;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !got || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** GET /settings: values and limits. POST /settings { key: value, ... } with the admin token: validate, apply, persist. */
export function settingsHandler(venue: Venue) {
  const strategy = config.strategy;
  const defs = DEFS.filter((d) => d.strategies.includes(strategy) && (!d.venues || d.venues.includes(venue.info.name)));
  const view = () => ({
    editable: !!config.adminToken,
    strategy,
    fields: defs.map((d) => ({ key: d.key, group: d.group, value: d.get(), min: d.min, max: d.max, step: d.step, unit: d.unit === "base" ? venue.info.base : d.unit === "quote" ? venue.info.quoteCcy : d.unit, options: d.options ?? null })),
    fixed: {
      venue: venue.info.label, market: venue.info.market, strategy, live: venue.live, model: config.model,
      leverage: venue.info.name === "okx" ? config.okx.leverage : null,
      tickMs: venue.info.name === "okx" ? null : venue.info.blockMs, horizonBlocks: config.horizonBlocks, lookbackBlocks: config.lookbackBlocks,
    },
  });

  return async (req: Request): Promise<{ status: number; body: unknown }> => {
    if (req.method === "GET") return { status: 200, body: view() };
    if (req.method !== "POST") return { status: 405, body: { error: "GET or POST" } };
    if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN to change settings" } };
    if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
    let patch: Record<string, unknown>;
    try { patch = (await req.json()) as Record<string, unknown>; } catch { return { status: 400, body: { error: "body must be JSON" } }; }

    // Validate everything first; apply nothing unless all of it is valid.
    const errors: Record<string, string> = {};
    const next = new Map<Def, number>();
    for (const [key, raw] of Object.entries(patch)) {
      const d = defs.find((x) => x.key === key);
      if (!d) { errors[key] = "not editable"; continue; }
      const v = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(v)) { errors[key] = "not a number"; continue; }
      if (v < d.min || v > d.max) { errors[key] = `between ${d.min} and ${d.max}`; continue; }
      if (d.options && !d.options.includes(v)) { errors[key] = `one of ${d.options.join(", ")}`; continue; }
      next.set(d, v);
    }
    const val = (key: string) => { const d = defs.find((x) => x.key === key); return d ? (next.has(d) ? next.get(d)! : d.get()) : undefined; };
    const size = val("tradeSize");
    if (size !== undefined) {
      if (size <= 0) errors.tradeSize = "must be above 0";
      else { const why = venue.checkSize?.(size); if (why) errors.tradeSize = why; }
    }
    const w1 = val("spike.window1Sec"), w2 = val("spike.window2Sec");
    if (w1 !== undefined && w2 !== undefined && w1 >= w2) errors["spike.window2Sec"] = "must be longer than the short window";
    // A new leverage keeps the take-profit and stop where they are in price: their ROE scales with it, unless
    // this same change sets them.
    const lev = defs.find((x) => x.key === "okx.leverage");
    if (lev && next.has(lev) && next.get(lev) !== lev.get()) {
      const k = next.get(lev)! / lev.get();
      for (const key of ["spike.takeProfitRoePct", "spike.stopLossRoePct"]) {
        const d = defs.find((x) => x.key === key);
        if (d && !next.has(d)) next.set(d, Math.min(d.max, Math.max(d.min, Math.round(d.get() * k * 100) / 100)));
      }
    }
    const cap = val("maxPosition");
    if (cap !== undefined && size !== undefined && cap < size) errors.maxPosition = "must be at least the order size";
    if (Object.keys(errors).length) return { status: 400, body: { error: "invalid", errors } };

    for (const [d, v] of next) d.set(v);
    persist();
    console.log(`settings changed from the dashboard: ${[...next].map(([d, v]) => `${d.key}=${v}`).join(" ")}`);
    return { status: 200, body: view() };
  };
}

/** Write every setting, plus the coin and the coin the sizes were chosen for, to data/settings.json. */
function persist(extra: { "okx.instId"?: string; sizesFor?: string } = {}) {
  let prev: Record<string, unknown> = {};
  try { if (existsSync(FILE)) prev = JSON.parse(readFileSync(FILE, "utf8")); } catch {}
  const out: Record<string, unknown> = {};
  for (const d of DEFS) out[d.key] = d.get();
  for (const k of ["okx.instId", "sizesFor"] as const) if (prev[k] !== undefined) out[k] = prev[k];
  Object.assign(out, extra);
  mkdirSync("data", { recursive: true });
  writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n");
}

/**
 * GET /instrument: the coin now, its order size, and the coins on offer.
 * POST /instrument { instId, tradeSize, maxPosition? } with the admin token: validate against the new coin's
 * lot and minimum, save, run `beforeRestart` (the spike trader closes its simulated positions), then exit
 * with RESTART_CODE so scripts/run.sh starts the bot on the new coin. Needs that supervisor, and a live run
 * must be flat.
 */
export function instrumentHandler(venue: Venue, beforeRestart: () => Promise<void> | void = () => {}, exit: (code: number) => void = (c) => process.exit(c)) {
  const list = async (): Promise<InstrumentChoice[]> => (venue.instruments ? await venue.instruments() : []);
  return async (req: Request): Promise<{ status: number; body: unknown }> => {
    if (venue.info.name !== "okx" || !venue.instruments) return { status: 404, body: { error: "only OKX can switch coins" } };
    if (req.method === "GET") {
      let choices: InstrumentChoice[] = [];
      try { choices = await list(); } catch (e) { return { status: 502, body: { error: `okx: ${(e as Error).message}` } }; }
      return { status: 200, body: { current: venue.info.market, tradeSize: config.tradeSize, maxPosition: config.maxPosition, strategy: config.strategy, editable: !!config.adminToken, supervised: config.supervised, blocker: venue.switchBlocker?.() ?? null, choices } };
    }
    if (req.method !== "POST") return { status: 405, body: { error: "GET or POST" } };
    if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN to change settings" } };
    if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
    if (!config.supervised) return { status: 409, body: { error: "not started by scripts/run.sh, so it cannot restart itself: set OKX_INST_ID in .env and restart" } };
    const blocker = venue.switchBlocker?.();
    if (blocker) return { status: 409, body: { error: `cannot switch: ${blocker}` } };
    let body: { instId?: string; tradeSize?: number; maxPosition?: number };
    try { body = (await req.json()) as typeof body; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
    const choice = (await list()).find((c) => c.instId === body.instId);
    const errors: Record<string, string> = {};
    if (!choice) errors.instId = "not an offered coin";
    const size = Number(body.tradeSize);
    if (choice) {
      const lots = size / choice.lot;
      if (!(size > 0)) errors.tradeSize = "must be above 0";
      else if (Math.abs(lots - Math.round(lots)) > 1e-9) errors.tradeSize = `must be a multiple of ${choice.lot} ${choice.base}`;
      else if (size < choice.min - 1e-12) errors.tradeSize = `must be at least ${choice.min} ${choice.base}`;
    }
    const cap = body.maxPosition === undefined ? Math.max(config.maxPosition * (size / (config.tradeSize || size)), size) : Number(body.maxPosition);
    if (!(cap >= size)) errors.maxPosition = "must be at least the order size";
    if (Object.keys(errors).length) return { status: 400, body: { error: "invalid", errors } };

    config.tradeSize = size;
    config.maxPosition = choice!.lot ? Number((Math.round(cap / choice!.lot) * choice!.lot).toFixed(10)) : cap;
    persist({ "okx.instId": choice!.instId, sizesFor: choice!.instId });
    console.log(`coin switch from the dashboard: ${venue.info.market} -> ${choice!.instId}, order ${size} ${choice!.base}, max ${config.maxPosition}; restarting`);
    setTimeout(async () => {
      try { await beforeRestart(); await venue.shutdown?.(); } catch (e) { console.warn(`before restart: ${(e as Error).message}`); }
      exit(RESTART_CODE);
    }, 300);
    return { status: 202, body: { restarting: true, instId: choice!.instId, tradeSize: size, maxPosition: config.maxPosition } };
  };
}
