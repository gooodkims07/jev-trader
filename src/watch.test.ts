import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alerts } from "./alerts";
import { config } from "./config";
import { AccountWatch } from "./watch";
import type { OkxApi } from "./okx-api";

process.chdir(mkdtempSync(join(tmpdir(), "jev-watch-test-")));

/** A fake account: positions, algo orders, max size, ledger, withdrawals; read-only like OKX. */
function account() {
  const s = {
    positions: [] as Record<string, string>[], algos: [] as Record<string, string>[], maxBuy: "10", maxSell: "10",
    bills: [] as Record<string, string>[], withdrawals: [] as Record<string, string>[], deposits: [] as Record<string, string>[],
  };
  const api = {
    async signed(_m: string, path: string, q: Record<string, string>) {
      if (path.endsWith("/positions")) return s.positions;
      if (path.endsWith("/orders-algo-pending")) return s.algos;
      if (path.endsWith("/max-size")) return [{ maxBuy: s.maxBuy, maxSell: s.maxSell }];
      if (path.endsWith("/bills")) return s.bills.filter((b) => b.type === q.type);
      if (path.endsWith("/withdrawal-history")) return s.withdrawals;
      if (path.endsWith("/deposit-history")) return s.deposits;
      throw new Error(path);
    },
    async public() { return [{ ctVal: "100" }]; },
  } as unknown as OkxApi;
  return { s, api };
}

test("account watch: a stopless position, liquidation levels, low balance, liquidations and withdrawals, each once", async () => {
  const saved = { size: config.tradeSize, sides: config.spike.sides };
  try {
    config.tradeSize = 20; config.spike.sides = 1;
    const { s, api } = account();
    const alerts = new Alerts(join(process.cwd(), "a.jsonl"));
    const w = new AccountWatch(api, alerts, { instId: "XRP-USDT-SWAP", base: "XRP", priceDecimals: 4 });
    const subjects = () => alerts.since(0).alerts.map((a) => a.subject);

    // A long with no stop: reported on the second check only, once.
    s.positions = [{ instId: "XRP-USDT-SWAP", pos: "2", avgPx: "1.5", markPx: "1.5", liqPx: "1.2", lever: "10" }];
    await w.check(); expect(subjects()).toEqual([]);
    await w.check(); await w.check();
    expect(subjects()).toEqual(["[감시] 손절 없는 포지션: XRP-USDT-SWAP 롱"]);
    s.algos = [{ instId: "XRP-USDT-SWAP", side: "sell", slTriggerPx: "1.48" }]; // a stop placed: cleared
    await w.check(); expect(subjects().length).toBe(1);

    // Liquidation 8% away, then 4%: two reports; staying at 4%: none more.
    s.positions[0]!.liqPx = "1.38"; await w.check();
    s.positions[0]!.liqPx = "1.44"; await w.check(); await w.check();
    expect(subjects().filter((x) => x.includes("청산가 근접")).length).toBe(2);

    // Max buy 0.1 contracts (10 XRP) < one order (20 XRP): reported once, again only after it clears.
    s.maxBuy = "0.1"; await w.check(); await w.check();
    s.maxBuy = "5"; await w.check(); s.maxBuy = "0"; await w.check();
    expect(subjects().filter((x) => x.includes("잔고 부족")).length).toBe(2);

    // A liquidation and a withdrawal after start; old ones are not reported.
    const later = String(Date.now() + 1000);
    s.bills = [{ billId: "1", type: "5", instId: "XRP-USDT-SWAP", balChg: "-30", pnl: "-30", ccy: "USDT", ts: later }, { billId: "0", type: "5", instId: "XRP-USDT-SWAP", balChg: "-1", pnl: "-1", ccy: "USDT", ts: "1" }];
    s.withdrawals = [{ ccy: "USDT", amt: "50", state: "0", ts: later, to: "TXk3" }];
    await w.check(); await w.check();
    expect(subjects().filter((x) => x.includes("강제청산") || x.includes("출금"))).toEqual(["[감시] 강제청산 발생: XRP-USDT-SWAP", "[감시] 출금 발생: 50 USDT"]);
  } finally { config.tradeSize = saved.size; config.spike.sides = saved.sides; }
});
