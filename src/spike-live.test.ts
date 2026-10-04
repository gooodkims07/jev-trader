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
  const ex = { pos: 0, avg: 0, orders: [] as { side: Side; size: number; reduceOnly: boolean }[], exits: [] as ({ side: Side; tp: number; sl: number } | null)[], exitsOk: true, exitState: "live" as "live" | "tp" | "sl" | "gone" | null, fills: [] as { px: number; size: number; fee: number; ts: number; id?: string; ordId?: string }[] };
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
    async fillsSince(_since, side) { return ex.fills.filter((f) => (f as { side?: Side }).side === undefined || (f as { side?: Side }).side === side); },
    async setExits(p) { ex.exits.push(p); ex.exitState = p ? "live" : null; return p ? ex.exitsOk : true; },
    async exitsState() { return ex.exitState; },
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
    f.ex.pos = 0; f.ex.exitState = "tp"; f.ex.fills = [{ px: tp, size: 5, fee: tp * 5 * 0.0005, ts: Date.now() }]; // the OCO fired on OKX
    f.setMid(tp); b = await settle(t, b); // two checks: a difference must show twice
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

const lastJevTrade = (from: number) => readFileSync("data/spike.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "trade" && r.who === "jev" && r.closedAt >= from).at(-1);
/** Blocks enough for two position checks (a difference must show twice). */
async function settle(t: SpikeTrader, b: number) { for (let i = 0; i < 5; i++) await t.onBlock(b++); return b; }

test("sync: a position closed in the OKX app is booked as manual, from the app's fills", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue(); const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("hold"), (_e, n) => { if (n) notes.push(n); });
    t["open"].set("jev", { who: "jev", side: "buy", entry: 2, size: 5, adds: 0, openedAt: 7000, spikeBlock: 7000, openedTs: 0, tp: 2.08, sl: 1.88, exitsOnExchange: true, entryFees: 0.005 });
    f.ex.pos = 5; f.ex.avg = 2;
    let b = await settle(t, 7000);
    expect(notes.some((n) => n.startsWith("EXIT"))).toBe(false); // in step: nothing to do
    f.setMid(2.05); f.ex.pos = 0; f.ex.exitState = "gone";
    f.ex.fills = [{ px: 2.05, size: 5, fee: 0.005, ts: Date.now(), id: "a1", ordId: "app1", side: "sell" } as never];
    b = await settle(t, b);
    expect(notes.find((n) => n.startsWith("EXIT"))).toMatch(/^EXIT manual \+/);
    expect(lastJevTrade(7000)).toMatchObject({ reason: "manual", exit: 2.05, size: 5 });
    expect(t.snapshot().open.length).toBe(0);
    expect(f.ex.orders.length).toBe(0); // the bot sent nothing
  } finally { reset(); }
});

test("sync: a part closed by hand is its own manual trade; the rest stays open", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    t["open"].set("jev", { who: "jev", side: "buy", entry: 2, size: 5, adds: 0, openedAt: 8000, spikeBlock: 8000, openedTs: 0, tp: 2.08, sl: 1.88, exitsOnExchange: true, entryFees: 0.005 });
    f.ex.pos = 3; f.ex.avg = 2;
    f.ex.fills = [{ px: 2.01, size: 2, fee: 0.002, ts: Date.now(), id: "p1", ordId: "app2", side: "sell" } as never];
    await settle(t, 8000);
    expect(lastJevTrade(8000)).toMatchObject({ reason: "manual", exit: 2.01, size: 2 });
    expect(t.snapshot().open[0]).toMatchObject({ size: 3, entry: 2 });
  } finally { reset(); }
});

test("sync: more bought by hand joins the position (exchange size and entry) and the exits move", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue(); const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("hold"), (_e, n) => { if (n) notes.push(n); });
    t["open"].set("jev", { who: "jev", side: "buy", entry: 2, size: 5, adds: 0, openedAt: 9000, spikeBlock: 9000, openedTs: 0, tp: 2.08, sl: 1.88, exitsOnExchange: true, entryFees: 0.005 });
    f.ex.pos = 10; f.ex.avg = 1.9;
    await settle(t, 9000);
    expect(t.snapshot().open[0]).toMatchObject({ size: 10, entry: 1.9, adds: 0 });
    expect(f.ex.exits.at(-1)!.tp).toBeCloseTo(1.9 * 1.04, 9);
    expect(notes.some((n) => n.startsWith("MANUAL add"))).toBe(true);
  } finally { reset(); }
});

test("sync: a position opened in the app while the bot is flat is taken over, with exits", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    f.ex.pos = -4; f.ex.avg = 2.1;
    await settle(t, 10000);
    expect(t.snapshot().open[0]).toMatchObject({ side: "sell", size: 4, entry: 2.1, adds: 0 });
    // 20 at 5 a time: counted as an entry and 3 adds
    const g = liveVenue(); const t2 = new SpikeTrader(g.v, says("hold"), () => {});
    g.ex.pos = 20; g.ex.avg = 2;
    await settle(t2, 10100);
    expect(t2.snapshot().open[0]).toMatchObject({ size: 20, adds: 3 });
    expect(f.ex.exits.at(-1)).toMatchObject({ side: "sell" });
    expect(f.ex.exits.at(-1)!.sl).toBeCloseTo(2.1 * 1.06, 9);
  } finally { reset(); }
});

test("sync: a one-check difference (the exchange lagging) is ignored", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    f.ex.pos = 5; f.ex.avg = 2;
    await t.onBlock(11000);
    f.ex.pos = 0;
    await t.onBlock(11002);
    expect(t.snapshot().open.length).toBe(0);
  } finally { reset(); }
});

test("sync: exits canceled by hand are placed again", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    t["open"].set("jev", { who: "jev", side: "buy", entry: 2, size: 5, adds: 0, openedAt: 12000, spikeBlock: 12000, openedTs: 0, tp: 2.08, sl: 1.88, exitsOnExchange: true, entryFees: 0.005 });
    f.ex.pos = 5; f.ex.avg = 2; f.ex.exitState = "gone";
    await t.onBlock(12000);
    expect(f.ex.exits.at(-1)).toEqual({ side: "buy", tp: 2.08, sl: 1.88 });
    expect(f.ex.exitState as string).toBe("live");
  } finally { reset(); }
});

test("observe: spikes are found and Jev asked, but no order is sent; back to trading, orders go again", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0; config.spike.observe = 1;
    const f = liveVenue(); const notes: string[] = [];
    const t = new SpikeTrader(f.v, says("buy"), (_e, n) => { if (n) notes.push(n); });
    let b = await openLong(t, f, 13000);
    expect(f.ex.orders.length).toBe(0);
    expect(notes.find((n) => n.startsWith("SPIKE"))).toMatch(/observing: no order/);
    expect(t.snapshot().spikes[0]).toMatchObject({ asked: true, effect: "observed" });
    expect(t.snapshot().plan.observe).toBe(true);
    config.spike.observe = 0;
    for (let i = 0; i < 200; i++) await t.onBlock(b++); // past the cooldown
    f.setMid(2 * 0.994 * 0.994); await t.onBlock(b++);
    expect(f.ex.orders).toEqual([{ side: "buy", size: 5, reduceOnly: false }]);
  } finally { reset(); config.spike.observe = 0; }
});

test("stats: trades taken over or closed by hand count as manual, not Jev's; each trade records how far it went", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    const before = t.snapshot().stats;
    // Taken over from the app, then closed there: one manual trade.
    f.ex.pos = 5; f.ex.avg = 2;
    let b = await settle(t, 14000);
    f.setMid(2.02); await t.onBlock(b++); f.setMid(1.99); await t.onBlock(b++); f.setMid(2.01);
    f.ex.pos = 0; f.ex.exitState = "gone";
    f.ex.fills = [{ px: 2.01, size: 5, fee: 0.005, ts: Date.now(), id: "m1", ordId: "app9", side: "sell" } as never];
    b = await settle(t, b);
    const s = t.snapshot();
    expect(s.stats.manual.trades).toBe(before.manual.trades + 1);
    expect(s.stats.jev.trades).toBe(before.jev.trades);
    expect(s.curve.at(-1)!.manual).toBeCloseTo(s.stats.manual.totalUsd, 4);
    const row = lastJevTrade(14000);
    expect(row).toMatchObject({ manual: true, reason: "manual" });
    expect(row.mfePct).toBeCloseTo(1, 3); // 2 -> 2.02
    expect(row.maePct).toBeCloseTo(-0.5, 3); // 2 -> 1.99
  } finally { reset(); }
});

test("excursions: the share of trades that reached each move, the plan's exits among the levels", async () => {
  config.tradeSize = 5; config.okx.leverage = 5;
  const f = liveVenue();
  const t = new SpikeTrader(f.v, says("hold"), () => {});
  const e = t.snapshot().excursions.fade;
  expect(e.reach.map((r) => r.pct)).toEqual(expect.arrayContaining([0.5, 1, 4, 6])); // 20% / 30% ROE at 5x: 4% and 6%
  expect(e.reach.every((r) => r.fav <= e.measured && r.adv <= e.measured)).toBe(true);
  reset();
});

test("applyExits: the open position takes the current take-profit and stop, on the exchange too", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("buy"), () => {});
    expect(await t.applyExits()).toBeNull(); // flat
    await openLong(t, f, 15000);
    const entry = t.snapshot().open.find((o) => o.who === "jev")!.entry;
    config.spike.takeProfitRoePct = 5; config.spike.stopLossRoePct = 5; // +-1% at 5x
    const r = await t.applyExits();
    expect(r).toMatchObject({ onExchange: true });
    expect(r!.tp).toBeCloseTo(entry * 1.01, 9);
    expect(f.ex.exits.at(-1)).toEqual({ side: "buy", tp: r!.tp, sl: r!.sl });
    expect(t.snapshot().open.find((o) => o.who === "jev")!.sl).toBeCloseTo(entry * 0.99, 9);
  } finally { reset(); }
});

test("leverage: an open position keeps its own for its ROE; the next one opens at the new one", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("buy"), () => {});
    let b = await openLong(t, f, 16000);
    const tp = f.ex.exits.at(-1)!.tp;
    config.okx.leverage = 10; config.spike.takeProfitRoePct *= 2; config.spike.stopLossRoePct *= 2; // what the settings do
    f.setMid(2 * 0.994 * 1.01); await t.onBlock(b++);
    const o = t.snapshot().open.find((x) => x.who === "jev")!;
    expect(o.unrealizedRoePct).toBeCloseTo(o.unrealizedPct * 5, 1); // still 5x
    expect(t.snapshot().plan.takeProfitPct).toBeCloseTo(4, 9); // same price move as before
    const r = await t.applyExits();
    expect(r!.tp).toBeCloseTo(tp, 9);
  } finally { reset(); }
});

test("hand orders: the take-profit and stop given with a dashboard order are used when the sync takes its fill over", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    t.noteManualExits("man1", 2, 0.5);
    f.ex.pos = -8; f.ex.avg = 2;
    f.ex.fills = [{ px: 2, size: 8, fee: 0.008, ts: Date.now(), id: "h1", ordId: "man1", side: "sell" } as never];
    await settle(t, 17000);
    const o = t.snapshot().open.find((x) => x.who === "jev")!;
    expect(o).toMatchObject({ side: "sell", size: 8, manual: true });
    expect(o.tp).toBeCloseTo(2 * 0.98, 9); // short: take-profit 2% lower
    expect(o.sl).toBeCloseTo(2 * 1.005, 9);
    expect(f.ex.exits.at(-1)).toMatchObject({ side: "sell" });
    expect(f.ex.exits.at(-1)!.tp).toBeCloseTo(1.96, 9);
  } finally { reset(); }
});

test("applyExits with prices: moves the take-profit and stop to them, refusing one on the wrong side of the price", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("buy"), () => {});
    let b = await openLong(t, f, 18000);
    await t.onBlock(b++);
    const mid = 2 * 0.994;
    const r = await t.applyExits({ tp: mid * 1.03 });
    expect(r!.tp).toBeCloseTo(mid * 1.03, 9);
    expect(f.ex.exits.at(-1)!.tp).toBeCloseTo(mid * 1.03, 9);
    await expect(t.applyExits({ sl: mid * 1.01 })).rejects.toThrow(/below the price now/);
    expect(t.snapshot().open.find((o) => o.who === "jev")!.tp).toBeCloseTo(mid * 1.03, 9);
  } finally { reset(); }
});

test("session limits: a manual position does not count, and is not closed when a limit stops the bot", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0.2;
    const f = liveVenue(); const halts: string[] = [];
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    t.onHalt = (r) => halts.push(r);
    f.ex.pos = 50; f.ex.avg = 2; // opened by hand
    let b = await settle(t, 19000);
    expect(t.snapshot().open.find((o) => o.who === "jev")).toMatchObject({ size: 50, manual: true });
    f.setMid(2 * 0.97); await t.onBlock(b++); await t.onBlock(b++); // -3% on 50 = -3 USDT, far past the 0.2 stop
    expect(halts).toEqual([]);
    await t.shutdown({ keepManual: true });
    expect(f.ex.pos).toBe(50); // left open
    expect(f.ex.orders.length).toBe(0);
  } finally { reset(); }
});

test("manual part: no time limit; exits moved by hand survive adds", async () => {
  const saved = config.spike.maxHoldMin;
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0; config.spike.maxHoldMin = 1;
    const f = liveVenue();
    const t = new SpikeTrader(f.v, says("buy"), () => {});
    let b = await openLong(t, f, 20000);
    const mid = 2 * 0.994;
    await t.onBlock(b++);
    await t.applyExits({ tp: mid * 1.05, sl: mid * 0.97 }); // dragged on the chart
    // More bought by hand: joins the position; the dragged exits stay.
    f.ex.pos = 15; f.ex.avg = mid * 0.999;
    b = await settle(t, b);
    let o = t.snapshot().open.find((x) => x.who === "jev")!;
    expect(o).toMatchObject({ size: 15, manual: true });
    expect(o.tp).toBeCloseTo(mid * 1.05, 9);
    expect(o.sl).toBeCloseTo(mid * 0.97, 9);
    // Past the 1 minute limit: not closed (it has a manual part).
    for (let i = 0; i < 70; i++) await t.onBlock(b++);
    o = t.snapshot().open.find((x) => x.who === "jev")!;
    expect(o).toBeDefined();
    expect(f.ex.orders.filter((x) => x.reduceOnly).length).toBe(0);
  } finally { reset(); config.spike.maxHoldMin = saved; }
});

test("restart: a position taken over keeps the exits the last run left on the exchange", async () => {
  try {
    config.tradeSize = 5; config.okx.leverage = 5; config.risk.sessionStopLoss = 0;
    const f = liveVenue();
    let carried: { tp: number; sl: number } | null = { tp: 2.3, sl: 1.9 };
    (f.v.exec as { takeCarriedExits?: () => unknown }).takeCarriedExits = () => { const x = carried; carried = null; return x; };
    const t = new SpikeTrader(f.v, says("hold"), () => {});
    f.ex.pos = 10; f.ex.avg = 2;
    await settle(t, 21000);
    expect(t.snapshot().open.find((o) => o.who === "jev")).toMatchObject({ tp: 2.3, sl: 1.9 });
    expect(f.ex.exits.at(-1)).toEqual({ side: "buy", tp: 2.3, sl: 1.9 });
  } finally { reset(); }
});

test("live and dry-run records are kept apart: each mode loads only its own", async () => {
  const f = liveVenue();
  const live = new SpikeTrader(f.v, says("hold"), () => {});
  const dryVenue = { ...(f.v as object), live: false, exec: undefined } as unknown as Venue;
  const dry = new SpikeTrader(dryVenue, says("hold"), () => {});
  const liveRows = readFileSync("data/spike.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(liveRows.every((r) => r.live === true)).toBe(true); // every row the live tests above wrote says so
  expect(live.snapshot().spikes.length).toBeGreaterThan(0);
  expect(dry.snapshot().spikes.length).toBe(0);
  expect(dry.snapshot().stats.jev.trades).toBe(0);
});
