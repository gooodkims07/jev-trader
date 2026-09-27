import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { settingsHandler } from "./settings";
import type { Venue } from "./venue";

process.chdir(mkdtempSync(join(tmpdir(), "jev-settings-test-")));

const venue = {
  info: { name: "okx", label: "OKX", market: "XRP-USDT-SWAP", symbol: "XRP-USDT PERP", base: "XRP", quoteCcy: "USDT", priceDecimals: 4, sizeDecimals: 0, clock: "tick", blockMs: 1000, txUrl: null },
  live: false,
  checkSize: (n: number) => (Number.isInteger(n) ? null : "must be a multiple of 1 XRP"),
} as unknown as Venue;

const post = (body: unknown, token?: string) =>
  new Request("http://x/settings", { method: "POST", body: JSON.stringify(body), headers: token ? { authorization: `Bearer ${token}` } : {} });

test("settings: readable always, writable only with the admin token, validated, applied and saved", async () => {
  const saved = { token: config.adminToken, size: config.tradeSize, cap: config.maxPosition, stop: config.risk.sessionStopLoss, tick: config.okx.tickMs };
  try {
    config.adminToken = undefined;
    const h = settingsHandler(venue);
    const get = await h(new Request("http://x/settings"));
    expect(get.status).toBe(200);
    expect((get.body as any).editable).toBe(false);
    expect((get.body as any).fields.some((f: any) => f.key === "tradeSize" && f.unit === "XRP")).toBe(true);
    expect(JSON.stringify(get.body)).not.toMatch(/dryRun|DRY_RUN|apiKey|secret|passphrase/i);
    expect((await h(post({ tradeSize: 7 }, "x"))).status).toBe(403); // no token configured: read-only

    config.adminToken = "s3cret-token";
    expect((await h(post({ tradeSize: 7 }))).status).toBe(401);
    expect((await h(post({ tradeSize: 7 }, "wrong-token!"))).status).toBe(401);

    const bad = await h(post({ tradeSize: 5.5, "risk.sessionStopLoss": -1, dryRun: 0 }, "s3cret-token"));
    expect(bad.status).toBe(400);
    expect((bad.body as any).errors).toEqual({ tradeSize: "must be a multiple of 1 XRP", "risk.sessionStopLoss": "between 0 and 1000000", dryRun: "not editable" });
    expect(config.tradeSize).toBe(saved.size); // nothing applied when anything is invalid

    const ok = await h(post({ tradeSize: 7, maxPosition: 35, "risk.sessionStopLoss": 1.5 }, "s3cret-token"));
    expect(ok.status).toBe(200);
    expect([config.tradeSize, config.maxPosition, config.risk.sessionStopLoss]).toEqual([7, 35, 1.5]);
    expect(existsSync("data/settings.json")).toBe(true);
    expect(JSON.parse(readFileSync("data/settings.json", "utf8"))).toMatchObject({ tradeSize: 7, maxPosition: 35, "risk.sessionStopLoss": 1.5 });

    expect((await h(post({ maxPosition: 3 }, "s3cret-token"))).status).toBe(400); // below the order size

    // Spike windows are spike-strategy settings; this venue runs mm in tests, so they are not offered here.
    expect((get.body as any).fields.some((f: any) => f.key === "spike.window1Sec")).toBe(false);

    // Tick length: OKX only, one of the offered lengths, applied at once.
    expect((get.body as any).fields.find((f: any) => f.key === "okx.tickMs").options).toEqual([1000, 3000, 5000, 10000, 15000, 30000, 60000]);
    const oddTick = await h(post({ "okx.tickMs": 2000 }, "s3cret-token"));
    expect((oddTick.body as any).errors).toEqual({ "okx.tickMs": "one of 1000, 3000, 5000, 10000, 15000, 30000, 60000" });
    expect((await h(post({ "okx.tickMs": 5000 }, "s3cret-token"))).status).toBe(200);
    expect(config.okx.tickMs).toBe(5000);
  } finally {
    config.adminToken = saved.token; config.tradeSize = saved.size; config.maxPosition = saved.cap; config.risk.sessionStopLoss = saved.stop; config.okx.tickMs = saved.tick;
  }
});

import { instrumentHandler } from "./settings";

test("coin switch: listed coins only, sizes on the new coin's lot, needs the supervisor and a flat live account, then saves and restarts", async () => {
  const saved = { token: config.adminToken, sup: config.supervised, size: config.tradeSize, cap: config.maxPosition, inst: config.okx.instId };
  const exits: number[] = [];
  let closed = 0, blocker: string | null = null;
  const v = {
    ...venue, shutdown: async () => {},
    switchBlocker: () => blocker,
    instruments: async () => [
      { instId: "XRP-USDT-SWAP", base: "XRP", last: 1.5, volUsd24h: 3e8, lot: 1, min: 1, tickSz: "0.0001" },
      { instId: "BTC-USDT-SWAP", base: "BTC", last: 110000, volUsd24h: 2e9, lot: 0.0001, min: 0.0001, tickSz: "0.1" },
    ],
  } as unknown as Venue;
  try {
    config.adminToken = "s3cret-token"; config.tradeSize = 5; config.maxPosition = 25;
    const h = instrumentHandler(v, () => { closed++; }, (c) => exits.push(c));
    const get = await h(new Request("http://x/instrument"));
    expect((get.body as any).choices.map((c: any) => c.instId)).toEqual(["XRP-USDT-SWAP", "BTC-USDT-SWAP"]);
    const req = (b: unknown) => new Request("http://x/instrument", { method: "POST", body: JSON.stringify(b), headers: { authorization: "Bearer s3cret-token" } });

    config.supervised = false;
    expect((await h(req({ instId: "BTC-USDT-SWAP", tradeSize: 0.0001 }))).status).toBe(409); // cannot restart itself
    config.supervised = true;
    blocker = "a position of 5 XRP is open";
    expect((await h(req({ instId: "BTC-USDT-SWAP", tradeSize: 0.0001 }))).status).toBe(409);
    blocker = null;

    const bad = await h(req({ instId: "BTC-USDT-SWAP", tradeSize: 0.00015 }));
    expect((bad.body as any).errors).toEqual({ tradeSize: "must be a multiple of 0.0001 BTC" });
    expect((await h(req({ instId: "DOGE-USDT-SWAP", tradeSize: 1 }))).status).toBe(400);

    const ok = await h(req({ instId: "BTC-USDT-SWAP", tradeSize: 0.0001 }));
    expect(ok.status).toBe(202);
    expect(ok.body).toMatchObject({ restarting: true, instId: "BTC-USDT-SWAP", tradeSize: 0.0001, maxPosition: 0.0005 }); // cap scaled with the size
    await Bun.sleep(400);
    expect(closed).toBe(1);
    expect(exits).toEqual([75]);
    expect(JSON.parse(readFileSync("data/settings.json", "utf8"))).toMatchObject({ "okx.instId": "BTC-USDT-SWAP", sizesFor: "BTC-USDT-SWAP", tradeSize: 0.0001 });
  } finally {
    config.adminToken = saved.token; config.supervised = saved.sup; config.tradeSize = saved.size; config.maxPosition = saved.cap; config.okx.instId = saved.inst;
  }
});

test("spike windows: offered lengths only, and the long window must be longer than the short one", async () => {
  const saved = { token: config.adminToken, strat: config.strategy, w1: config.spike.window1Sec, w2: config.spike.window2Sec };
  try {
    config.adminToken = "s3cret-token"; config.strategy = "spike";
    const h = settingsHandler(venue);
    const get = await h(new Request("http://x/settings"));
    expect((get.body as any).fields.find((f: any) => f.key === "spike.window1Sec").options).toEqual([30, 60, 120, 180, 300, 600, 900]);
    const post = (b: unknown) => h(new Request("http://x/settings", { method: "POST", body: JSON.stringify(b), headers: { authorization: "Bearer s3cret-token" } }));
    expect(((await post({ "spike.window1Sec": 45 })).body as any).errors).toEqual({ "spike.window1Sec": "one of 30, 60, 120, 180, 300, 600, 900" });
    expect(((await post({ "spike.window1Sec": 300 })).body as any).errors).toEqual({ "spike.window2Sec": "must be longer than the short window" });
    const ok = await post({ "spike.window1Sec": 30, "spike.window2Sec": 300 });
    expect(ok.status).toBe(200);
    expect([config.spike.window1Sec, config.spike.window2Sec]).toEqual([30, 300]);
  } finally {
    config.adminToken = saved.token; config.strategy = saved.strat; config.spike.window1Sec = saved.w1; config.spike.window2Sec = saved.w2;
  }
});
