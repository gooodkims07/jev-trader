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
  const saved = { token: config.adminToken, size: config.tradeSize, cap: config.maxPosition, stop: config.risk.sessionStopLoss };
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
  } finally {
    config.adminToken = saved.token; config.tradeSize = saved.size; config.maxPosition = saved.cap; config.risk.sessionStopLoss = saved.stop;
  }
});
