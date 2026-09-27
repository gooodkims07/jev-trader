import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { SpikeTrader, type SpikeModel } from "./spike";
import type { BlockEvent } from "./trader";
import { summarize, type Book, type Venue } from "./venue";

process.chdir(mkdtempSync(join(tmpdir(), "jev-spike-test-")));

function venue(): Venue & { setMid(m: number): void } {
  let mid = 1.5;
  const book = (): Book => ({ block: 0, bid: mid - 0.00005, ask: mid + 0.00005, mid, spreadBps: 0.67, imbalance: 0, levels: { bids: [[mid - 0.00005, 100]], asks: [[mid + 0.00005, 100]] }, depthBps: {} });
  return {
    info: { name: "okx", label: "OKX", market: "XRP-USDT-SWAP", symbol: "XRP-USDT PERP", base: "XRP", quoteCcy: "USDT", priceDecimals: 4, sizeDecimals: 0, clock: "tick", blockMs: 1000, txUrl: null },
    account: null, live: false, canAfford: () => true, makerFeeRate: 0.0002,
    trades: { async poll() {}, summary: (n, b) => summarize([], n, b), recent: () => [], drainPrints: () => [], drainFills: () => [] },
    async init() {}, startClock() {}, async refresh() {},
    async readBook() { return book(); },
    quotePrice: () => mid,
    async send() { throw new Error("spike never posts limit orders"); },
    async pollPending() { return []; },
    setMid(m: number) { mid = m; },
  };
}

const says = (action: "buy" | "sell" | "hold"): SpikeModel => ({ name: "t", async decide() { return { action, probabilities: { buy: 0, sell: 0, hold: 0, [action]: 0.9 }, upIn10: 0, latencyMs: 1, inputTokens: 1 }; } });

async function warm(t: SpikeTrader, v: ReturnType<typeof venue>, from: number, n: number, mid: number) {
  v.setMid(mid);
  for (let b = from; b < from + n; b++) await t.onBlock(b);
  return from + n;
}

test("a 0.6% jump in a minute is a spike: Jev fades it, the shadows fade and follow, and the take-profit closes Jev's short", async () => {
  // 5x leverage: ROE +20% / -30% = price +4% / -6%.
  const v = venue(); const events: BlockEvent[] = []; const notes: string[] = [];
  const t = new SpikeTrader(v, says("sell"), (e, n) => { events.push(e); if (n) notes.push(n); });
  let b = await warm(t, v, 1, 200, 1.5);   // 200 s flat: enough history for 1 and 3 minutes
  v.setMid(1.5 * 1.006); await t.onBlock(b++); // +0.6% vs a minute ago
  expect(notes.at(-1)).toContain("SPIKE up 0.60% in 1m -> sell (fade)");
  expect(events.at(-1)!.position.side).toBe("short");
  expect(events.at(-1)!.fill!.price).toBeCloseTo(1.5 * 1.006 - 0.00005, 8); // a market sell gets the bid

  b = await warm(t, v, b, 10, 1.5 * 1.006);  // nothing new: cooldown, and in a position
  expect(notes.filter((n) => n.startsWith("SPIKE")).length).toBe(1);

  v.setMid(1.5 * 1.006 * 0.935); await t.onBlock(b++); // -6.5% from entry: take-profit for the shorts, stop for the long
  expect(notes.at(-1)).toMatch(/^EXIT take-profit \+/);
  expect(events.at(-1)!.position.side).toBe("flat");
  expect(events.at(-1)!.totals.pnlUsd).toBeGreaterThan(0);

  const rows = readFileSync("data/spike.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(rows[0]).toMatchObject({ type: "spike", window: "1m", direction: "up", asked: true, jev: { action: "sell" } });
  const trades = rows.filter((r) => r.type === "trade");
  expect(trades.map((r) => `${r.who}:${r.reason}`).sort()).toEqual(["fade:take-profit", "follow:stop-loss", "jev:take-profit"]);
});

test("stay out: no position for Jev, the shadows still trade; the time limit closes them", async () => {
  const saved = config.spike.maxHoldMin;
  config.spike.maxHoldMin = 2;
  try {
    const v = venue(); const events: BlockEvent[] = []; const notes: string[] = [];
    const t = new SpikeTrader(v, says("hold"), (e, n) => { events.push(e); if (n) notes.push(n); });
    let b = await warm(t, v, 10_000, 200, 2); // blocks of its own: data/spike.jsonl is shared with the test above
    v.setMid(2 * 0.99); await t.onBlock(b++); // -1% in a minute
    expect(notes.at(-1)).toContain("-> stay out");
    expect(events.at(-1)!.position.side).toBe("flat");
    expect(events.at(-1)!.totals.skips).toBe(1);
    await warm(t, v, b, 125, 2 * 0.99);
    const rows = readFileSync("data/spike.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.type === "trade" && r.spikeBlock === b - 1);
    expect(rows.map((r) => `${r.who}:${r.reason}`).sort()).toEqual(["fade:time", "follow:time"]);
  } finally {
    config.spike.maxHoldMin = saved;
  }
});

test("snapshot: plan, gauge, open positions, Jev vs rules, and the spike list for the dashboard", async () => {
  const v = venue();
  const t = new SpikeTrader(v, says("buy"), () => {});
  let b = await warm(t, v, 20_000, 200, 1);
  v.setMid(0.994); await t.onBlock(b++); // -0.6%: Jev buys (fades the drop)
  const s = t.snapshot();
  expect(s.plan).toMatchObject({ takeProfitPct: 4, stopLossPct: 6, leverage: 5, maxHoldMin: 240, base: "XRP" });
  expect(s.gauge.r1Pct).toBeCloseTo(-0.6, 3);
  expect(s.gauge.cooldownSec).toBeGreaterThan(0);
  expect(s.open.map((o) => `${o.who}:${o.side}`).sort()).toEqual(["fade:buy", "follow:sell", "jev:buy"]);
  expect(s.spikes[0]).toMatchObject({ block: b - 1, direction: "down", jevOpen: true, trade: null });
  expect(Object.keys(s.stats).sort()).toEqual(["fade", "follow", "jev"]);
  expect(Array.isArray(s.curve)).toBe(true);
});

test("5 s ticks: windows are time, not tick counts (blocks are seconds)", async () => {
  const v = venue(); const notes: string[] = [];
  const t = new SpikeTrader(v, says("hold"), (_e, n) => { if (n) notes.push(n); });
  v.setMid(3);
  let b = 30_000;
  for (let i = 0; i < 40; i++, b += 5) await t.onBlock(b); // 200 s of history in 5 s steps
  expect(t.snapshot().gauge.r1Pct).toBe(0);
  v.setMid(3 * 1.006); await t.onBlock(b); // +0.6% vs 60 s ago
  expect(notes.at(-1)).toContain("SPIKE up 0.60% in 1m");
  expect(t.snapshot().gauge.cooldownSec).toBe(180);
  b += 5; await t.onBlock(b);
  expect(t.snapshot().gauge.cooldownSec).toBe(175);
});

test("windows are settings: a 30 s window catches a move the 1 m window would", async () => {
  const saved = { w1: config.spike.window1Sec, w2: config.spike.window2Sec };
  config.spike.window1Sec = 30; config.spike.window2Sec = 300;
  try {
    const v = venue(); const notes: string[] = [];
    const t = new SpikeTrader(v, says("hold"), (_e, n) => { if (n) notes.push(n); });
    let b = await warm(t, v, 40_000, 40, 2); // 40 s of history: enough for 30 s, not for 5 m
    v.setMid(2 * 1.006); await t.onBlock(b++);
    expect(notes.at(-1)).toContain("SPIKE up 0.60% in 30s");
    expect(t.snapshot().plan).toMatchObject({ window1Sec: 30, window2Sec: 300 });
    expect(t.snapshot().gauge.r3Pct).toBeNull(); // the 5 m window has no history yet
  } finally {
    config.spike.window1Sec = saved.w1; config.spike.window2Sec = saved.w2;
  }
});

const queue = (...actions: ("buy" | "sell" | "hold")[]): SpikeModel => ({ name: "q", async decide() { const a = actions.shift() ?? "hold"; return { action: a, probabilities: { buy: 0, sell: 0, hold: 0, [a]: 0.9 }, upIn10: 0, latencyMs: 1, inputTokens: 1 }; } });

/** Flat for `secs`, then a one-tick move of `pct` %; returns the next block. */
async function spikeAfter(t: SpikeTrader, v: ReturnType<typeof venue>, b: number, secs: number, mid: number, pct: number) {
  b = await warm(t, v, b, secs, mid);
  v.setMid(mid * (1 + pct / 100)); await t.onBlock(b++);
  return b;
}

test("adds: a second spike on the same side adds an order at the average price, up to SPIKE_MAX_ADDS", async () => {
  const saved = { adds: config.spike.maxAdds, rev: config.spike.allowReverse, size: config.tradeSize };
  config.spike.maxAdds = 1; config.spike.allowReverse = 0; config.tradeSize = 5;
  try {
    const v = venue(); const notes: string[] = [];
    const t = new SpikeTrader(v, queue("buy", "buy", "buy"), (_e, n) => { if (n) notes.push(n); });
    let b = await spikeAfter(t, v, 50_000, 200, 1, -0.6);       // Jev buys the drop
    expect(notes.at(-1)).toContain(": open");
    b = await spikeAfter(t, v, b, 200, 0.994, -0.6);             // another drop, after the cooldown
    expect(notes.at(-1)).toContain(": add");
    const jev = t.snapshot().open.find((o) => o.who === "jev")!;
    expect(jev.size).toBe(10);
    expect(jev.adds).toBe(1);
    expect(jev.entry).toBeLessThan(0.994); // averaged down
    b = await spikeAfter(t, v, b, 200, 0.988, -0.6);             // no adds left: held as it is
    expect(notes.at(-1)).toContain(": hold");
    expect(t.snapshot().open.find((o) => o.who === "jev")!.size).toBe(10);
  } finally {
    config.spike.maxAdds = saved.adds; config.spike.allowReverse = saved.rev; config.tradeSize = saved.size;
  }
});

test("reverse: the other side closes the position (reason reverse) and opens the other way; off, it holds", async () => {
  const saved = { adds: config.spike.maxAdds, rev: config.spike.allowReverse };
  config.spike.maxAdds = 0; config.spike.allowReverse = 1;
  try {
    const v = venue(); const notes: string[] = [];
    const t = new SpikeTrader(v, queue("buy", "sell"), (_e, n) => { if (n) notes.push(n); });
    let b = await spikeAfter(t, v, 60_000, 200, 1, -0.6);
    b = await spikeAfter(t, v, b, 200, 0.994, 0.6);
    expect(notes.at(-1)).toContain(": reverse (closed");
    expect(t.snapshot().open.find((o) => o.who === "jev")!.side).toBe("sell");
    const rows = readFileSync("data/spike.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.some((r) => r.type === "trade" && r.who === "jev" && r.reason === "reverse" && r.openedAt >= 60_000)).toBe(true);

    config.spike.allowReverse = 0;
    const t2 = new SpikeTrader(v, queue("buy", "sell"), (_e, n) => { if (n) notes.push(n); });
    b = await spikeAfter(t2, v, 70_000, 200, 1, -0.6);
    b = await spikeAfter(t2, v, b, 200, 0.994, 0.6);
    expect(notes.at(-1)).toContain("(in a position: not asked)"); // adds and reverse both off: not even asked
    expect(t2.snapshot().open.find((o) => o.who === "jev")!.side).toBe("buy");
  } finally {
    config.spike.maxAdds = saved.adds; config.spike.allowReverse = saved.rev;
  }
});

test("adds on, reverse off: the other side is asked about but held", async () => {
  const saved = { adds: config.spike.maxAdds, rev: config.spike.allowReverse };
  config.spike.maxAdds = 2; config.spike.allowReverse = 0;
  try {
    const v = venue(); const notes: string[] = [];
    const t = new SpikeTrader(v, queue("buy", "sell"), (_e, n) => { if (n) notes.push(n); });
    let b = await spikeAfter(t, v, 90_000, 200, 1, -0.6);
    b = await spikeAfter(t, v, b, 200, 0.994, 0.6);
    expect(notes.at(-1)).toContain("-> sell (fade): hold");
    expect(t.snapshot().open.find((o) => o.who === "jev")!.side).toBe("buy");
  } finally {
    config.spike.maxAdds = saved.adds; config.spike.allowReverse = saved.rev;
  }
});

test("both off: in a position Jev is not asked again (as before)", async () => {
  const v = venue(); const notes: string[] = [];
  const t = new SpikeTrader(v, queue("buy", "buy"), (_e, n) => { if (n) notes.push(n); });
  let b = await spikeAfter(t, v, 80_000, 200, 1, -0.6);
  b = await spikeAfter(t, v, b, 200, 0.994, -0.6);
  expect(notes.at(-1)).toContain("(in a position: not asked)");
});

test("resetReference: moves already made stop counting; the next move is measured from the current price", async () => {
  const v = venue(); const notes: string[] = [];
  const t = new SpikeTrader(v, says("hold"), (_e, n) => { if (n) notes.push(n); });
  let b = await warm(t, v, 100_000, 200, 2);
  b = await warm(t, v, b, 30, 2 * 1.004);          // +0.4% over 30 s: under the 0.5% trigger
  expect(t.snapshot().gauge.r1Pct).toBeCloseTo(0.4, 3);
  expect(t.resetReference()).toBeCloseTo(2.008, 9);
  expect(t.snapshot().gauge.r1Pct).toBe(0);
  v.setMid(2.008 * 1.003); await t.onBlock(b++);   // +0.3% from the new reference: no spike (without the reset it was +0.7%)
  expect(notes.some((n) => n.startsWith("SPIKE"))).toBe(false);
  v.setMid(2.008 * 1.006); await t.onBlock(b++);   // +0.6% from the reference: a spike, at once
  expect(notes.at(-1)).toContain("SPIKE up 0.60% in 1m");
});

import { spikeQuestions } from "./spike";

test("sides: long only drops the short answer from Jev's question, and no one opens a short", async () => {
  const saved = config.spike.sides;
  config.spike.sides = 1;
  try {
    const info = venue().info;
    expect(Object.keys(spikeQuestions(info).direction.criteria)).toEqual(["buy", "hold"]);
    const v = venue(); const notes: string[] = [];
    const t = new SpikeTrader(v, says("sell"), (_e, n) => { if (n) notes.push(n); });
    let b = await warm(t, v, 110_000, 200, 1.5);
    v.setMid(1.5 * 1.006); await t.onBlock(b++);          // an up spike: fade would short, follow would long
    expect(notes.at(-1)).toContain(": out");               // Jev's short is not allowed: stays out
    const open = t.snapshot().open.map((o) => `${o.who}:${o.side}`);
    expect(open).toEqual(["follow:buy"]);                  // the fade short is not allowed either
    expect(t.snapshot().plan.sides).toBe("long");
    config.spike.sides = 2;
    expect(Object.keys(spikeQuestions(info).direction.criteria)).toEqual(["sell", "hold"]);
    config.spike.sides = 0;
    expect(Object.keys(spikeQuestions(info).direction.criteria)).toEqual(["buy", "sell", "hold"]);
  } finally {
    config.spike.sides = saved;
  }
});
