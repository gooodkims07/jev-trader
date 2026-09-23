import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trader, queueAhead, type BlockEvent } from "./trader";
import type { Model } from "./model";
import { summarize, type Book, type OrderId, type Quote, type Side, type TradePrint, type TradeSource, type Venue } from "./venue";

class FakeTrades implements TradeSource {
  prints: TradePrint[] = [];
  fresh: TradePrint[] = [];
  async poll() {}
  summary(n: number, b: number) { return summarize(this.prints, n, b); }
  recent(n: number) { return this.prints.slice(-n); }
  drainPrints() { const o = this.fresh; this.fresh = []; return o; }
  drainFills() { return []; }
}

const book = (block: number): Book => ({
  block, bid: 34.8, ask: 35.0, mid: 34.9, spreadBps: 57, imbalance: 0,
  levels: { bids: [[34.8, 100]], asks: [[35.0, 100]] }, depthBps: {},
});

/** A dry-run venue: quotes one unit inside, never sends. */
function fakeVenue(price = 34.9): Venue & { trades: FakeTrades; sent: OrderId[][] } {
  const sent: OrderId[][] = [];
  return {
    info: { name: "upbit", label: "Upbit", market: "KRW-MON", symbol: "MON-KRW", base: "MON", quoteCcy: "KRW", priceDecimals: 1, sizeDecimals: 1, clock: "tick", txUrl: null },
    account: null, live: false, funds: { mon: 0, quote: 0 }, makerFeeRate: 0.0005,
    trades: new FakeTrades(), sent,
    async init() {}, startClock() {}, async refresh() {},
    async readBook() { return book(0); },
    quotePrice: () => price,
    async send(_b, side, size, _book, cancel, capped): Promise<Quote> {
      sent.push(cancel);
      return { side, price, size, txHash: null, ref: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };
    },
    async pollPending() { return []; },
  };
}

// The Trader appends every event to data/events.jsonl: keep that out of the real log.
process.chdir(mkdtempSync(join(tmpdir(), "jev-trader-test-")));

const buyer: Model = { name: "buyer", async decide() { return { action: "buy", probabilities: { buy: 0.9, sell: 0.1, hold: 0 }, upIn10: 0.9, latencyMs: 1, inputTokens: 100 }; } };

test("dry run: the order rests one block and a taker sell through it fills us, net of the maker fee", async () => {
  const venue = fakeVenue();
  const events: BlockEvent[] = [];
  const fills: number[] = [];
  const trader = new Trader(venue, buyer, (e) => events.push(e), (b) => fills.push(b));

  await trader.onBlock(10);
  expect(events.at(-1)!.quote!.side).toBe("buy");
  expect(events.at(-1)!.resting.bidMon).toBe(200);

  // A taker sell at our bid in the next block takes our simulated order.
  const print: TradePrint = { block: 11, price: 34.9, size: 500, side: "sell" };
  venue.trades.prints.push(print);
  venue.trades.fresh.push(print);
  await trader.onBlock(11);
  await Bun.sleep(0);
  expect(fills).toEqual([11]);

  await trader.onBlock(12);
  const last = events.at(-1)!;
  expect(last.position.side).toBe("long");
  expect(last.position.size).toBe(200);
  expect(last.totals.feesUsd).toBeCloseTo(200 * 34.9 * 0.0005, 6);
  // Simulated orders are never sent as cancels.
  expect(venue.sent.every((c) => c.length === 0)).toBe(true);
});

const print = (venue: ReturnType<typeof fakeVenue>, p: TradePrint) => { venue.trades.prints.push(p); venue.trades.fresh.push(p); };

test("queueAhead: the size at our price on our side, 0 inside the spread", () => {
  expect(queueAhead("buy", 34.8, book(0))).toBe(100);
  expect(queueAhead("sell", 35.0, book(0))).toBe(100);
  expect(queueAhead("buy", 34.9, book(0))).toBe(0);
});

test("dry run at the touch: prints at our price fill the queue ahead first; a print through it fills the rest", async () => {
  const venue = fakeVenue(34.8); // join the best bid, behind 100 already resting there
  const fills: number[] = [];
  const events: BlockEvent[] = [];
  const trader = new Trader(venue, buyer, (e) => events.push(e), (b) => fills.push(b));
  await trader.onBlock(20);

  print(venue, { block: 21, price: 34.8, size: 60, side: "sell" }); // all of it goes to the 100 ahead
  print(venue, { block: 21, price: 34.8, size: 5, side: "buy" }); // taker buy: not against our bid
  await trader.onBlock(21);
  await Bun.sleep(0);
  expect(fills).toEqual([]);

  // The order from block 21 queues behind the full 100 again: replacing an order loses its place.
  print(venue, { block: 22, price: 34.8, size: 130, side: "sell" }); // 100 ahead, 30 to us
  await trader.onBlock(22);
  await Bun.sleep(0);
  expect(fills).toEqual([22]);

  print(venue, { block: 23, price: 34.7, size: 1, side: "sell" }); // through our price: the whole level went
  await trader.onBlock(23);
  await Bun.sleep(0);
  expect(fills).toEqual([22, 23]);

  await trader.onBlock(24);
  expect(events.at(-1)!.position.size).toBe(230); // 30 from the queue, then all 200 of block 22's order
});
