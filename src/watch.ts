/**
 * Account watch (live OKX): once a minute, read the account and tell the coin-trade office (as alerts) when
 * something changes for the worse. Each condition is reported once when it starts, and again only after it
 * has cleared and come back, so the office (and its Jev calls) is not flooded.
 *
 *  1. A position without a stop: no stop-loss order on the exchange for two checks running (any coin).
 *  2. Near liquidation: the mark price within 10%, 5% or 3% of the estimated liquidation price.
 *  3. Not enough balance for Jev's next order: OKX's max order size is below the order size.
 *  4. A liquidation or auto-deleveraging in the ledger, and new withdrawals and deposits.
 *
 * Read-only: it never places, moves or cancels anything.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config";
import type { Alerts } from "./alerts";
import type { OkxApi } from "./okx-api";

const STATE = "data/watch.json";
const LIQ_LEVELS = [10, 5, 3]; // % from liquidation: each one closer is reported once

type Pos = { instId: string; pos: string; avgPx: string; markPx: string; liqPx: string; lever: string };
type Algo = { instId: string; side: string; slTriggerPx: string };
type Bill = { billId: string; type: string; instId: string; balChg: string; pnl: string; ccy: string; ts: string };
type Transfer = { ccy: string; amt: string; state: string; ts: string; to?: string; txId?: string; wdId?: string; depId?: string };

export class AccountWatch {
  private unprotected = new Map<string, number>(); // instId -> checks seen without a stop
  private warnedStop = new Set<string>();
  private liqLevel = new Map<string, number>(); // instId -> deepest level reported
  private lowWarned = false;
  private cursor: { bills: number; withdrawals: number; deposits: number };
  private ctVal: number | null = null;

  constructor(private api: OkxApi, private alerts: Alerts, private info: { instId: string; base: string; priceDecimals: number }) {
    let saved: Partial<typeof this.cursor> = {};
    try { if (existsSync(STATE)) saved = JSON.parse(readFileSync(STATE, "utf8")); } catch { /* start fresh */ }
    const now = Date.now(); // first run: only what happens from now on
    this.cursor = { bills: saved.bills ?? now, withdrawals: saved.withdrawals ?? now, deposits: saved.deposits ?? now };
  }

  start(everyMs = 60_000) {
    const run = () => this.check().catch((e) => console.warn(`account watch: ${(e as Error).message}`));
    setTimeout(run, 15_000); // after the bot has taken over any open position
    setInterval(run, everyMs);
  }

  private save() { try { writeFileSync(STATE, JSON.stringify(this.cursor)); } catch { /* kept in memory */ } }
  private side(pos: number) { return pos > 0 ? "롱" : "숏"; }

  async check() {
    const [positions, algos] = await Promise.all([
      this.api.signed<Pos[]>("GET", "/api/v5/account/positions", {}),
      this.api.signed<Algo[]>("GET", "/api/v5/trade/orders-algo-pending", { ordType: "conditional,oco" }),
    ]);
    const open = positions.filter((p) => Number(p.pos) !== 0);
    const px = (x: string | number) => Number(x).toFixed(this.info.priceDecimals);

    // 1. No stop on the exchange (two checks in a row, so a restart's brief gap does not count).
    for (const p of open) {
      const pos = Number(p.pos), close = pos > 0 ? "sell" : "buy";
      const hasStop = algos.some((a) => a.instId === p.instId && a.side === close && Number(a.slTriggerPx) > 0);
      if (hasStop) { this.unprotected.delete(p.instId); this.warnedStop.delete(p.instId); continue; }
      const n = (this.unprotected.get(p.instId) ?? 0) + 1;
      this.unprotected.set(p.instId, n);
      if (n >= 2 && !this.warnedStop.has(p.instId)) {
        this.warnedStop.add(p.instId);
        this.alerts.add("watch", `[감시] 손절 없는 포지션: ${p.instId} ${this.side(pos)}`,
          `${p.instId} ${this.side(pos)} 포지션(${Math.abs(pos)} 계약)에 손절 주문이 2분 넘게 없습니다. 평균가 ${px(p.avgPx)}, 마크가격 ${px(p.markPx)}, 예상 청산가 ${p.liqPx ? px(p.liqPx) : "-"}, 레버리지 ${p.lever}배. 손절 없이 열린 포지션은 크게 잃을 수 있습니다.`);
      }
    }
    for (const id of [...this.unprotected.keys()]) if (!open.some((p) => p.instId === id)) { this.unprotected.delete(id); this.warnedStop.delete(id); }

    // 2. Near liquidation: report each level once as the price gets closer.
    for (const p of open) {
      const mark = Number(p.markPx), liq = Number(p.liqPx);
      if (!(mark > 0 && liq > 0)) continue;
      const dist = (Math.abs(mark - liq) / mark) * 100;
      const level = LIQ_LEVELS.filter((l) => dist < l).length; // 0 = far, 1..3 = within 10 / 5 / 3 %
      const was = this.liqLevel.get(p.instId) ?? 0;
      if (level > was) {
        const pos = Number(p.pos);
        this.alerts.add("watch", `[감시] 청산가 근접: ${p.instId} ${dist.toFixed(1)}% 남음`,
          `${p.instId} ${this.side(pos)} 포지션의 마크가격 ${px(mark)}이 예상 청산가 ${px(liq)}에서 ${dist.toFixed(1)}% 떨어져 있습니다. 평균가 ${px(p.avgPx)}, 레버리지 ${p.lever}배. 포지션을 줄이거나 증거금을 넣지 않으면 강제청산될 수 있습니다.`);
      }
      this.liqLevel.set(p.instId, level);
    }
    for (const id of [...this.liqLevel.keys()]) if (!open.some((p) => p.instId === id)) this.liqLevel.delete(id);

    // 3. Jev cannot enter: OKX's max order size on an allowed side is below one order.
    if (this.ctVal === null) {
      const [inst] = await this.api.public<{ ctVal: string }[]>("/api/v5/public/instruments", { instType: "SWAP", instId: this.info.instId });
      this.ctVal = Number(inst?.ctVal ?? 1);
    }
    const [max] = await this.api.signed<{ maxBuy: string; maxSell: string }[]>("GET", "/api/v5/account/max-size", { instId: this.info.instId, tdMode: config.okx.marginMode });
    const need = config.tradeSize / this.ctVal, sides = config.spike.sides; // 0 both, 1 long, 2 short
    const room = sides === 1 ? Number(max?.maxBuy) : sides === 2 ? Number(max?.maxSell) : Math.min(Number(max?.maxBuy), Number(max?.maxSell));
    const low = room + 1e-9 < need;
    if (low && !this.lowWarned) {
      this.alerts.add("watch", "[감시] 잔고 부족: Jev 진입 불가",
        `${this.info.instId}에서 지금 낼 수 있는 최대 주문이 ${(room * this.ctVal).toFixed(0)} ${this.info.base}로, Jev의 다음 주문(${config.tradeSize} ${this.info.base})보다 작습니다. 급변이 와도 진입을 건너뜁니다. 증거금을 쓰고 있는 포지션을 줄이거나 입금하면 다시 진입할 수 있습니다.`);
    }
    this.lowWarned = low;

    // 4. The ledger: liquidations (type 5) and auto-deleveraging (type 9); then withdrawals and deposits.
    const bills = (await Promise.all(["5", "9"].map((type) => this.api.signed<Bill[]>("GET", "/api/v5/account/bills", { type, limit: "20" })))).flat()
      .filter((b) => Number(b.ts) > this.cursor.bills).sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const b of bills) {
      this.alerts.add("watch", `[감시] ${b.type === "5" ? "강제청산" : "자동 감축(ADL)"} 발생: ${b.instId}`,
        `${b.instId}에서 ${b.type === "5" ? "강제청산" : "자동 감축(ADL)"}이 일어났습니다. 손익 ${b.pnl} ${b.ccy}, 잔고 변화 ${b.balChg} ${b.ccy}.`);
      this.cursor.bills = Math.max(this.cursor.bills, Number(b.ts));
    }
    const [wds, deps] = await Promise.all([
      this.api.signed<Transfer[]>("GET", "/api/v5/asset/withdrawal-history", { limit: "20" }).catch(() => [] as Transfer[]),
      this.api.signed<Transfer[]>("GET", "/api/v5/asset/deposit-history", { limit: "20" }).catch(() => [] as Transfer[]),
    ]);
    for (const w of wds.filter((x) => Number(x.ts) > this.cursor.withdrawals).sort((a, b) => Number(a.ts) - Number(b.ts))) {
      this.alerts.add("watch", `[감시] 출금 발생: ${w.amt} ${w.ccy}`,
        `OKX 계정에서 출금 기록이 생겼습니다: ${w.amt} ${w.ccy}, 받는 주소 ${w.to ?? "-"}, 상태 코드 ${w.state}. 본인이 한 출금이 아니면 즉시 API 키를 끄고 비밀번호를 바꾸세요.`, "OKX 자금 알림");
      this.cursor.withdrawals = Math.max(this.cursor.withdrawals, Number(w.ts));
    }
    for (const d of deps.filter((x) => Number(x.ts) > this.cursor.deposits && x.state === "2").sort((a, b) => Number(a.ts) - Number(b.ts))) {
      this.alerts.add("watch", `[감시] 입금 완료: ${d.amt} ${d.ccy}`, `OKX 계정에 입금이 완료되었습니다: ${d.amt} ${d.ccy}.`, "OKX 자금 알림");
      this.cursor.deposits = Math.max(this.cursor.deposits, Number(d.ts));
    }
    this.save();
  }
}
