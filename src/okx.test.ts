import { expect, test } from "bun:test";
import { OkxError, newClOrdId, sign, stepDecimals } from "./okx-api";
import { OkxVenue } from "./okx";
import { questions } from "./model";
import { config } from "./config";
import { bookFromLevels, type VenueInfo } from "./venue";

// Expected values computed independently with Python's hmac/hashlib, using the example secret from OKX's docs.
const SECRET = "22582BD0CFF14C41EDBF1AB98506286D";

test("sign: base64 HMAC-SHA256 over timestamp + METHOD + requestPath (+ query) + body", () => {
  expect(sign(SECRET, "2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=USDT")).toBe("Ku79U+75wKPSP3i+t02ssUto76AYiAT/aws7hI3GZpg=");
  expect(sign(SECRET, '2020-12-08T09:08:57.715ZPOST/api/v5/trade/order{"instId":"XRP-USDT-SWAP","sz":"0.05"}')).toBe("9x25KbJ8FyHFodZvumx8bOkBwix0lcmi3QXnXk6jWAM=");
  // WebSocket login: unix seconds + GET + /users/self/verify
  expect(sign(SECRET, "1538054050GET/users/self/verify")).toBe("+LdIr8lkkvhr5hoA3g9TMC0+uQJ849ftAcocA/ouu4M=");
});

test("clOrdId: letters and digits only, at most 32, starts with jev", () => {
  for (let i = 0; i < 50; i++) {
    const id = newClOrdId();
    expect(id).toMatch(/^jev[0-9a-f]{29}$/);
    expect(id.length).toBe(32);
  }
});

test("stepDecimals", () => {
  expect(stepDecimals("0.00001")).toBe(5);
  expect(stepDecimals("0.1")).toBe(1);
  expect(stepDecimals("1")).toBe(0);
  expect(stepDecimals("10")).toBe(0);
});

/** A venue with XRP-USDT-SWAP's instrument (tick 0.0001, 100 XRP contracts, lots of 0.01), no network. */
function xrpSwap() {
  const v = new OkxVenue() as any;
  Object.assign(v, { tick: 0.0001, tickDec: 4, ctVal: 100, lotSz: 0.01 });
  return v as { quotePrice: OkxVenue["quotePrice"]; toBook: (m: unknown, ms: number) => ReturnType<typeof bookFromLevels> };
}

test("books arrive in contracts and leave in XRP", () => {
  const book = xrpSwap().toBook({ bids: [["1.4620", "12.5", "0", "3"]], asks: [["1.4622", "0.4", "0", "4"]], ts: "0" }, 0);
  expect(book.levels.bids[0]).toEqual([1.462, 1250]);
  expect(book.levels.asks[0]).toEqual([1.4622, 40]);
});

test("quotePrice: one tick inside, never crossing, join the touch when one tick wide", () => {
  const v = xrpSwap();
  const wide = bookFromLevels(1, [[1.462, 1]], [[1.4622, 1]]);
  expect(v.quotePrice("buy", wide)).toBe(1.4621);
  expect(v.quotePrice("sell", wide)).toBe(1.4621);
  const tight = bookFromLevels(1, [[1.462, 1]], [[1.4621, 1]]);
  expect(v.quotePrice("buy", tight)).toBe(1.462);
  expect(v.quotePrice("sell", tight)).toBe(1.4621);
});

test("Jev's OKX question: bid, ask or skip, judged against the fee; Kuru's is unchanged", () => {
  const okx: VenueInfo = { name: "okx", label: "OKX", market: "XRP-USDT-SWAP", symbol: "XRP-USDT PERP", base: "XRP", quoteCcy: "USDT", priceDecimals: 4, sizeDecimals: 0, clock: "tick", blockMs: 1000, txUrl: null };
  const q = questions(okx).direction;
  expect(q.instructions.question).toStartWith("Post a bid, post an ask, or skip this tick?");
  expect(q.instructions.question).toContain("`costs.makerFeeBps`");
  expect(Object.keys(q.criteria)).toEqual(["buy", "sell", "hold"]);
  expect(q.criteria.hold).toStartWith("Skip:");
  expect(q.instructions.goal).toStartWith("Make markets on the XRP-USDT perpetual swap on OKX. Each block here is a 1 s tick.");
  expect(q.instructions.goal).toContain("(~100 s)"); // HORIZON_BLOCKS (100 in tests) x 1 s
  expect(q.instructions.inputs).toContain("`position`");
  expect(q.instructions.inputs).toContain("`lookbackBlocks`");
  expect(q.instructions.inputs).toEndWith("Sizes and every field ending in `Mon` are in XRP.");
  expect(JSON.stringify(q)).not.toMatch(/\bMON\b/);

  const kuru = questions({ ...okx, name: "kuru", label: "Kuru", market: "", symbol: "MON-USDC", base: "MON", quoteCcy: "USDC", blockMs: 300 }).direction;
  expect(kuru.instructions.goal).toStartWith("Make markets on MON-USDC on Kuru.");
  expect(Object.keys(kuru.criteria)).toEqual(["buy", "sell"]); // no skip on Kuru: an order every block
});

test("stops at once when OKX refuses the key for trading, not on outages", () => {
  const kills: string[] = [];
  const realKill = process.kill;
  (process as any).kill = (_pid: number, sig: string) => { kills.push(sig); return true; };
  try {
    const v = new OkxVenue() as any;
    v.rejectFailure(new OkxError(0, "network", "timeout")); // transient errors never reach here in replace(), but must not halt
    expect(v.halted).toBe(false);
    v.rejectFailure(new OkxError(401, "50123", "This API Key does not have trading permission"));
    expect(v.halted).toBe(true);
    expect(kills).toEqual(["SIGINT"]);
    v.rejectFailure(new OkxError(401, "50123", "again"));
    expect(kills).toEqual(["SIGINT"]); // only once
  } finally {
    (process as any).kill = realKill;
  }
});

test("other refusals stop the bot after 20 in a row", () => {
  const kills: string[] = [];
  const realKill = process.kill;
  (process as any).kill = (_pid: number, sig: string) => { kills.push(sig); return true; };
  try {
    const v = new OkxVenue() as any;
    for (let i = 0; i < 19; i++) v.rejectFailure(new OkxError(200, "51008", "Insufficient USDT margin"));
    expect(v.halted).toBe(false);
    v.rejectFailure(new OkxError(200, "51008", "Insufficient USDT margin"));
    expect(v.halted).toBe(true);
    expect(kills).toEqual(["SIGINT"]);
  } finally {
    (process as any).kill = realKill;
  }
});

test("emergency stop: 7% from the entry on the closing side, on the tick; none when flat", () => {
  const saved = config.okx.emergencyStopPct;
  config.okx.emergencyStopPct = 7;
  try {
    const v = new OkxVenue() as any;
    Object.assign(v, { tick: 0.0001, tickDec: 4, ctVal: 100, lotSz: 0.01 }); // XRP-USDT-SWAP
    expect(v.stopFor({ mon: 15, entry: 1.518 })).toEqual({ side: "sell", trigger: 1.4117 }); // long: 1.518 x 0.93
    expect(v.stopFor({ mon: -15, entry: 1.518 })).toEqual({ side: "buy", trigger: 1.6243 }); // short: 1.518 x 1.07
    expect(v.stopFor({ mon: 0, entry: null })).toBeNull();
  } finally {
    config.okx.emergencyStopPct = saved;
  }
});

test("client ids: orders start jev, stops jevsl, both 32 letters and digits", () => {
  expect(newClOrdId("jevsl")).toMatch(/^jevsl[0-9a-f]{27}$/);
});
