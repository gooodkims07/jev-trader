import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { SpikeTrader, type SpikeModel } from "./spike";
import { summarize, type Book, type MarketExec, type Side, type Venue } from "./venue";

process.chdir(mkdtempSync(join(tmpdir(), "jev-spike-live-test-")));

/** A live venue whose exchange is a fake: market orders fill at the touch, 0.05% fee; a position, exits, fills. */
function liveVenue() {
  let mid = 2;
  const ex = { pos: 0, avg: 0, orders: [] as { side: Side; size: number; reduceOnly: boolean }[], exits: [] as ({ side: Side; tp: number; sl: number } | null)[], exitsOk: true, fills: [] as { px: number; size: number; fee: number; ts: number }[] };
  const book = (): Book => ({ block: 0, bid: mid - 0.0001, ask: mid + 0.0001, mid, spreadBps: 1, imbalance: 0, levels: { bids: [[mid - 0.0001, 100]], asks: [[mid + 0.0001, 100]] }, depthBps: {} });
  const exec: MarketExec = {
    async marketOrder(side, size, reduceOnly) {
      ex.orders.push({ side, size, reduceOnly });
      const px = side === "buy" ? mid + 0.0001 : mid - 0.0001, d = side === "buy" ? size : -size;
      if (reduceOnly && Math.abs(ex.pos) < size - 1e-9) throw new Error("no position to reduce");
      ex.avg = ex.pos + d === 0 ? 0 : Math.sign(ex.pos) === Math.sign(d) || ex.pos === 0 ? (ex.avg * Math.abs(ex.pos) + px * size) / (Math.abs(ex.pos) + size) : ex.avg;
      ex.pos += d;
      return { ordId: `o${ex.orders.length}`, avgPx: px, size, fee: px * size * 0.0005 };
    },
    async positionNow() { return { size: ex.pos, avgPx: ex.avg }; },
    async fillsSince() { return ex.fills; },
    async setExits(p) { ex.exits.push(p); return p ? ex.exitsOk : true; },
  };
  const v = {
    info: { name: "okx", label: "OKX", market: "XRP-USDT-SWAP", symbol: "XRP-USDT PERP", base: "XRP", quoteCcy: "USDT", priceDecimals: 4, sizeDecimals: 0, clock: "tick", blockMs: 1000, txUrl: null },
    account: "okx", live: true, exec, canAfford: () => true, makerFeeRate: 0.0002,
    trades: { async poll() {}, summary: (n: number, b: number) => summarize([], n, b), recent: () => [], drainPrints: () => [], drainFills: () => [] },
    async init() {}, startClock() {}, async refresh() {}, async readBook() { return book(); },
    quotePrice: () => mid, async send() { throw new Error("no limit orders"); }, async pollPending() { return []; },
  } as unknown as Venue;
  return { v, ex, setMid: (m: number) => { mid = m; } };
}

const says = (a: "buy" | "sell" | "hold"): SpikeModel => ({ name: "t", async decide() { return { action: a, probabilities: { buy: 0, sell: 0, hold: 0, [a]: 0.9 }, upIn10: 0, latencyMs: 1, inputTokens: 1 }; } });

async function openLong(t: SpikeTrader, f: ReturnType<typeof liveVenue>, from: number) {
  f.setMid(2);
  let b = from;
  for (; b < from + 200; b++) await t.onBlock(b);
  f.setMid(2 * 0.994); await t.onBlock(b++); // -0.6%: Jev buys
  return b;
}

const saved = { tp: config.spike.takeProfitRoePct, sl: config.spike.stopLossRoePct, lev: config.okx.leverage, hold: config.spike.maxHoldMin, ss: config.risk.sessionStopLoss, st: config.risk.sessionTakeProfit, size: config.tradeSize };
const reset = () => { config.spike.takeProfitRoePct = saved.tp; config.spike.stopLossRoePct = saved.sl; config.okx.leverage = saved.lev; config.spike.maxHoldMin = saved.hold; config.risk.sessionStopLoss = saved.ss; config.risk.sessionTakeProfit = saved.st; config.tradeSize = saved.size; };

test("live: Jev's buy is a market order, and the take-profit / stop go to the exchange as one OCO", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue(); const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("buy"), (_e, n) => { if (n) notes.push(n); });
    await openLong(t, f, 1000);
    expect(f.ex.orders).toEqual([{ side: "buy", size: 5, reduceOnly: false }]);
    const e = f.ex.exits.at(-1)!;
    expect(e.side).toBe("buy");
    expect(e.tp / (2 * 0.994 + 0.0001)).toBeCloseTo(1.04, 6); // +20% ROE / 5x = +4%
    expect(e.sl / (2 * 0.994 + 0.0001)).toBeCloseTo(0.94, 6); // -30% ROE / 5x = -6%
  } finally { reset(); }
});

test("live: when the exchange's take-profit closes the position, the exit is booked from the real fills", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue(); const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("buy"), (_e, n) => { if (n) notes.push(n); });
    let b = await openLong(t, f, 2000);
    const tp = f.ex.exits.at(-1)!.tp;
    f.ex.pos = 0; f.ex.fills = [{ px: tp, size: 5, fee: tp * 5 * 0.0005, ts: Date.now() }]; // the OCO fired on OKX
    f.setMid(tp); await t.onBlock(b++); await t.onBlock(b++); await t.onBlock(b++);
    expect(notes.find((n) => n.startsWith("EXIT"))).toMatch(/^EXIT take-profit \+/);
    expect(f.ex.orders.length).toBe(1); // the bot sent no close of its own
    const row = readFileSync("data/spike.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "trade" && r.who === "jev" && r.openedAt >= 2000).at(-1);
    expect(row).toMatchObject({ reason: "take-profit", exit: tp, size: 5 });
    expect(row.roePct).toBeGreaterThan(18); // +20% ROE less fees
  } finally { reset(); }
});

test("live: the time limit closes with a reduce-only market order, taking the OCO off first", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0; config.spike.maxHoldMin = 1;
    const f = liveVenue(); const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("buy"), (_e, n) => { if (n) notes.push(n); });
    let b = await openLong(t, f, 3000);
    for (let i = 0; i < 61; i++) await t.onBlock(b++);
    expect(notes.find((n) => n.startsWith("EXIT"))).toMatch(/^EXIT time/);
    expect(f.ex.exits.at(-1)).toBeNull();
    expect(f.ex.orders.at(-1)).toEqual({ side: "sell", size: 5, reduceOnly: true });
    expect(f.ex.pos).toBe(0);
  } finally { reset(); }
});

test("live: if the exchange refuses the OCO, the bot closes at the take-profit itself", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue(); f.ex.exitsOk = false; const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("buy"), (_e, n) => { if (n) notes.push(n); });
    let b = await openLong(t, f, 4000);
    f.setMid(2 * 0.994 * 1.05); await t.onBlock(b++);
    expect(notes.find((n) => n.startsWith("EXIT"))).toMatch(/^EXIT take-profit/);
    expect(f.ex.orders.at(-1)).toEqual({ side: "sell", size: 5, reduceOnly: true });
  } finally { reset(); }
});

test("live: the session stop closes the position and halts; shutdown closes too", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0.2; config.spike.stopLossRoePct = 90; // the stop is far; the session limit comes first
    const f = liveVenue(); const halts: string[] = [];
    const t = new SpikeTrader(f.v, says("buy"), () => {});
    t.onHalt = (r) => halts.push(r);
    let b = await openLong(t, f, 5000);
    f.setMid(2 * 0.994 * 0.97); await t.onBlock(b++); // -3% on 5 XRP ~ -0.3 USDT
    expect(halts).toEqual(["session-stop"]);
    expect(f.ex.pos).toBe(0);
    const n = f.ex.orders.length;
    await t.onBlock(b++);
    expect(f.ex.orders.length).toBe(n); // halted: nothing more

    config.risk.sessionStopLoss = 0;
    const g = liveVenue();
    const t2 = new SpikeTrader(g.v, says("buy"), () => {});
    await openLong(t2, g, 6000);
    await t2.shutdown();
    expect(g.ex.pos).toBe(0);
    expect(g.ex.orders.at(-1)!.reduceOnly).toBe(true);
  } finally { reset(); }
});
