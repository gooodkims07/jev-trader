import { expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { krwTick, queryString, signJwt, tickDecimals } from "./upbit-api";
import { UpbitVenue, bookFromLevels } from "./upbit";

test("krwTick follows the KRW price unit table at range edges", () => {
  expect(krwTick(34.9)).toBe(0.1);
  expect(krwTick(10)).toBe(0.1);
  expect(krwTick(9.99)).toBe(0.01);
  expect(krwTick(100)).toBe(1);
  expect(krwTick(99.9)).toBe(0.1);
  expect(krwTick(1_500_000)).toBe(1000);
  expect(tickDecimals(0.1)).toBe(1);
  expect(tickDecimals(0.01)).toBe(2);
  expect(tickDecimals(1)).toBe(0);
});

test("signJwt: HS512 over header.payload, query_hash is sha512 of the raw query string", () => {
  const q = queryString({ market: "KRW-MON", side: "bid", price: "34.9" });
  expect(q).toBe("market=KRW-MON&side=bid&price=34.9");
  const [h, p, sig] = signJwt("AK", "SK", q).split(".");
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS512", typ: "JWT" });
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  expect(payload.access_key).toBe("AK");
  expect(payload.nonce).toMatch(/^[0-9a-f-]{36}$/);
  expect(payload.query_hash).toBe(createHash("sha512").update(q).digest("hex"));
  expect(payload.query_hash_alg).toBe("SHA512");
  expect(sig).toBe(createHmac("sha512", "SK").update(`${h}.${p}`).digest("base64url"));
  // No parameters: no query_hash at all.
  const bare = JSON.parse(Buffer.from(signJwt("AK", "SK").split(".")[1]!, "base64url").toString());
  expect(bare.query_hash).toBeUndefined();
});

test("bookFromLevels: best first on both sides, spread and depth", () => {
  const book = bookFromLevels(7, [[34.8, 100], [34.7, 50]], [[35.0, 80], [35.1, 20]]);
  expect(book.bid).toBe(34.8);
  expect(book.ask).toBe(35.0);
  expect(book.mid).toBeCloseTo(34.9, 10);
  expect(book.spreadBps).toBeCloseTo((0.2 / 34.9) * 10_000, 6);
  expect(book.levels.asks[0]).toEqual([35.0, 80]);
  expect(book.imbalance).toBeCloseTo((150 - 100) / 250, 10);
  expect(() => bookFromLevels(1, [], [[35, 1]])).toThrow();
});

test("quotePrice steps one price unit inside the touch and never crosses", () => {
  const v = new UpbitVenue();
  const wide = bookFromLevels(1, [[34.7, 1]], [[35.0, 1]]);
  expect(v.quotePrice("buy", wide)).toBe(34.8);
  expect(v.quotePrice("sell", wide)).toBe(34.9);
  // One unit wide: stepping in would cross, so join the touch.
  const tight = bookFromLevels(1, [[34.8, 1]], [[34.9, 1]]);
  expect(v.quotePrice("buy", tight)).toBe(34.8);
  expect(v.quotePrice("sell", tight)).toBe(34.9);
  // Across the 10 KRW boundary the unit below 10 is 0.01.
  const edge = bookFromLevels(1, [[9.9, 1]], [[10.0, 1]]);
  expect(v.quotePrice("sell", edge)).toBe(9.99);
  expect(v.quotePrice("buy", edge)).toBe(9.91);
});
