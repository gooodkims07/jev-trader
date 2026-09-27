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
import type { Venue } from "./venue";

const FILE = "data/settings.json";

type Group = "spike" | "size" | "risk" | "mm";
interface Def { key: string; group: Group; min: number; max: number; step: number; unit: string; get(): number; set(v: number): void; strategies: ("mm" | "spike")[] }

const DEFS: Def[] = [
  { key: "spike.move1mPct", group: "spike", min: 0.05, max: 10, step: 0.05, unit: "%", get: () => config.spike.move1mPct, set: (v) => { config.spike.move1mPct = v; }, strategies: ["spike"] },
  { key: "spike.move3mPct", group: "spike", min: 0.05, max: 20, step: 0.05, unit: "%", get: () => config.spike.move3mPct, set: (v) => { config.spike.move3mPct = v; }, strategies: ["spike"] },
  { key: "spike.takeProfitRoePct", group: "spike", min: 1, max: 500, step: 1, unit: "% ROE", get: () => config.spike.takeProfitRoePct, set: (v) => { config.spike.takeProfitRoePct = v; }, strategies: ["spike"] },
  { key: "spike.stopLossRoePct", group: "spike", min: 1, max: 500, step: 1, unit: "% ROE", get: () => config.spike.stopLossRoePct, set: (v) => { config.spike.stopLossRoePct = v; }, strategies: ["spike"] },
  { key: "spike.maxHoldMin", group: "spike", min: 1, max: 1440, step: 1, unit: "min", get: () => config.spike.maxHoldMin, set: (v) => { config.spike.maxHoldMin = v; }, strategies: ["spike"] },
  { key: "spike.cooldownSec", group: "spike", min: 0, max: 3600, step: 10, unit: "s", get: () => config.spike.cooldownSec, set: (v) => { config.spike.cooldownSec = v; }, strategies: ["spike"] },
  { key: "tradeSize", group: "size", min: 0, max: 1e9, step: 1, unit: "base", get: () => config.tradeSize, set: (v) => { config.tradeSize = v; }, strategies: ["mm", "spike"] },
  { key: "maxPosition", group: "size", min: 0, max: 1e9, step: 1, unit: "base", get: () => config.maxPosition, set: (v) => { config.maxPosition = v; }, strategies: ["mm"] },
  { key: "minSideProb", group: "mm", min: 0, max: 1, step: 0.05, unit: "", get: () => config.minSideProb, set: (v) => { config.minSideProb = v; }, strategies: ["mm"] },
  { key: "risk.sessionStopLoss", group: "risk", min: 0, max: 1e6, step: 0.5, unit: "quote", get: () => config.risk.sessionStopLoss, set: (v) => { config.risk.sessionStopLoss = v; }, strategies: ["mm"] },
  { key: "risk.sessionTakeProfit", group: "risk", min: 0, max: 1e6, step: 0.5, unit: "quote", get: () => config.risk.sessionTakeProfit, set: (v) => { config.risk.sessionTakeProfit = v; }, strategies: ["mm"] },
  { key: "risk.positionStopPct", group: "risk", min: 0, max: 100, step: 0.5, unit: "%", get: () => config.risk.positionStopPct, set: (v) => { config.risk.positionStopPct = v; }, strategies: ["mm"] },
  { key: "risk.positionTakePct", group: "risk", min: 0, max: 1000, step: 0.5, unit: "%", get: () => config.risk.positionTakePct, set: (v) => { config.risk.positionTakePct = v; }, strategies: ["mm"] },
  { key: "okx.emergencyStopPct", group: "risk", min: 0, max: 100, step: 0.5, unit: "%", get: () => config.okx.emergencyStopPct, set: (v) => { config.okx.emergencyStopPct = v; }, strategies: ["mm"] },
];

/** Apply data/settings.json over the .env values. Call once at startup, before the venue starts. */
export function applySavedSettings() {
  if (!existsSync(FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, number>;
    const applied: string[] = [];
    for (const d of DEFS) if (typeof saved[d.key] === "number" && saved[d.key]! >= d.min && saved[d.key]! <= d.max) { d.set(saved[d.key]!); applied.push(`${d.key}=${saved[d.key]}`); }
    if (applied.length) console.log(`settings from ${FILE}: ${applied.join(" ")}`);
  } catch (e) {
    console.warn(`${FILE}: ${(e as Error).message}; ignored`);
  }
}

function tokenOk(req: Request) {
  const want = config.adminToken;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!want || !got || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** GET /settings: values and limits. POST /settings { key: value, ... } with the admin token: validate, apply, persist. */
export function settingsHandler(venue: Venue) {
  const strategy = config.strategy;
  const defs = DEFS.filter((d) => d.strategies.includes(strategy) && (d.key !== "okx.emergencyStopPct" || venue.info.name === "okx"));
  const view = () => ({
    editable: !!config.adminToken,
    strategy,
    fields: defs.map((d) => ({ key: d.key, group: d.group, value: d.get(), min: d.min, max: d.max, step: d.step, unit: d.unit === "base" ? venue.info.base : d.unit === "quote" ? venue.info.quoteCcy : d.unit })),
    fixed: {
      venue: venue.info.label, market: venue.info.market, strategy, live: venue.live, model: config.model,
      leverage: venue.info.name === "okx" ? config.okx.leverage : null,
      tickMs: venue.info.blockMs, horizonBlocks: config.horizonBlocks, lookbackBlocks: config.lookbackBlocks,
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
      next.set(d, v);
    }
    const val = (key: string) => { const d = defs.find((x) => x.key === key); return d ? (next.has(d) ? next.get(d)! : d.get()) : undefined; };
    const size = val("tradeSize");
    if (size !== undefined) {
      if (size <= 0) errors.tradeSize = "must be above 0";
      else { const why = venue.checkSize?.(size); if (why) errors.tradeSize = why; }
    }
    const cap = val("maxPosition");
    if (cap !== undefined && size !== undefined && cap < size) errors.maxPosition = "must be at least the order size";
    if (Object.keys(errors).length) return { status: 400, body: { error: "invalid", errors } };

    for (const [d, v] of next) d.set(v);
    const saved: Record<string, number> = {};
    for (const d of DEFS) saved[d.key] = d.get();
    mkdirSync("data", { recursive: true });
    writeFileSync(FILE, JSON.stringify(saved, null, 2) + "\n");
    console.log(`settings changed from the dashboard: ${[...next].map(([d, v]) => `${d.key}=${v}`).join(" ")}`);
    return { status: 200, body: view() };
  };
}
