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
