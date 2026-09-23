import { expect, test } from "bun:test";
import { newClOrdId, sign, stepDecimals } from "./okx-api";
import { OkxVenue } from "./okx";
import { questions } from "./model";
import { bookFromLevels, type VenueInfo } from "./venue";

// Expected values computed independently with Python's hmac/hashlib, using the example secret from OKX's docs.
const SECRET = "22582BD0CFF14C41EDBF1AB98506286D";

test("sign: base64 HMAC-SHA256 over timestamp + METHOD + requestPath (+ query) + body", () => {
  expect(sign(SECRET, "2020-12-08T09:08:57.715ZGET/api/v5/account/balance?ccy=USDT")).toBe("Ku79U+75wKPSP3i+t02ssUto76AYiAT/aws7hI3GZpg=");
  expect(sign(SECRET, '2020-12-08T09:08:57.715ZPOST/api/v5/trade/order{"instId":"MON-USDT-SWAP","sz":"20"}')).toBe("D/l8rzAnDNHvrCyonnfOzknaxied4b3JiL3jEegP7PI=");
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

/** A venue with MON-USDT-SWAP's instrument (tick 0.00001, 10 MON contracts), no network. */
function monSwap() {
  const v = new OkxVenue() as any;
  Object.assign(v, { tick: 0.00001, tickDec: 5, ctVal: 10, lotSz: 1 });
  return v as { quotePrice: OkxVenue["quotePrice"]; toBook: (m: unknown, ms: number) => ReturnType<typeof bookFromLevels> };
}

test("books arrive in contracts and leave in MON", () => {
  const book = monSwap().toBook({ bids: [["0.02462", "1024", "0", "3"]], asks: [["0.02464", "429", "0", "4"]], ts: "0" }, 0);
  expect(book.levels.bids[0]).toEqual([0.02462, 10240]);
  expect(book.levels.asks[0]).toEqual([0.02464, 4290]);
});

test("quotePrice: one tick inside, never crossing, join the touch when one tick wide", () => {
  const v = monSwap();
  const wide = bookFromLevels(1, [[0.02462, 1]], [[0.02464, 1]]);
  expect(v.quotePrice("buy", wide)).toBe(0.02463);
  expect(v.quotePrice("sell", wide)).toBe(0.02463);
  const tight = bookFromLevels(1, [[0.02462, 1]], [[0.02463, 1]]);
  expect(v.quotePrice("buy", tight)).toBe(0.02462);
  expect(v.quotePrice("sell", tight)).toBe(0.02463);
});

test("Jev's OKX question is about the perpetual; Kuru's is unchanged", () => {
  const okx: VenueInfo = { name: "okx", label: "OKX", market: "MON-USDT-SWAP", symbol: "MON-USDT PERP", base: "MON", quoteCcy: "USDT", priceDecimals: 5, sizeDecimals: 0, clock: "tick", txUrl: null };
  const q = questions(okx).direction;
  expect(q.instructions.goal).toStartWith("Make markets on the MON-USDT perpetual swap on OKX.");
  expect(q.instructions.goal).toContain("being short is as easy as being long");
  const kuru = questions({ ...okx, name: "kuru", label: "Kuru", symbol: "MON-USDC", quoteCcy: "USDC" }).direction;
  expect(kuru.instructions.goal).toStartWith("Make markets on MON-USDC on Kuru.");
});
