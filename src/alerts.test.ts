import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Alerts } from "./alerts";
import { alertFor, shadowAlert } from "./spike-main";
import type { BlockEvent } from "./trader";

test("alerts: ids grow, kept on disk across a restart, read back by `after`", () => {
  const file = join(mkdtempSync(join(tmpdir(), "jev-alerts-")), "alerts.jsonl");
  const a = new Alerts(file);
  const x = a.add("exit", "s1", "b1"), y = a.add("exit", "s2", "b2");
  expect(y.id).toBeGreaterThan(x.id);
  const b = new Alerts(file); // a restart
  expect(b.since(0).alerts.map((v) => v.subject)).toEqual(["s1", "s2"]);
  expect(b.since(x.id).alerts.map((v) => v.subject)).toEqual(["s2"]);
  expect(b.since(y.id)).toEqual({ alerts: [], last: y.id });
});

test("alertFor: exits, session stops, entries and manual changes become alerts; quiet notes do not", () => {
  const e = { mid: 1.5, position: { side: "long", size: 20 }, totals: { pnlUsd: 1.2 } } as unknown as BlockEvent;
  expect(alertFor("EXIT take-profit +1.300% (ROE 13.0%, +1.09 USDT)", e, "XRP", "USDT")).toMatchObject({ kind: "exit", subject: "[spike] EXIT take-profit (익절)" });
  expect(alertFor("session-stop: session P&L -4.4 USDT, position closed, stopping", e, "XRP", "USDT")).toMatchObject({ kind: "halt", subject: "[spike] session-stop, 봇 정지" });
  expect(alertFor("SPIKE down -0.81% in from high -> buy (fade): open", e, "XRP", "USDT")).toMatchObject({ kind: "entry" });
  expect(alertFor("SPIKE down -0.81% in from high -> stay out: hold", e, "XRP", "USDT")).toBeNull();
  expect(alertFor("MANUAL position taken over: long 450 at 1.496", e, "XRP", "USDT")).toMatchObject({ kind: "manual", subject: "[spike] 수동 포지션 인계" });
  expect(alertFor("EXIT time -0.1%", e, "XRP", "USDT")!.body).toContain("롱 20 XRP");
  expect(alertFor("MANUAL position taken over: long 292 at 1.4698164383561645", e, "XRP", "USDT")!.body).toContain("at 1.4698\n현재가 1.5000");
});

test("shadowAlert: a virtual trade is marked as such, with its result on a close", () => {
  const o = shadowAlert({ who: "trend", what: "open", side: "buy", price: 1.53141, size: 20 }, "XRP", "USDT");
  expect(o.subject).toBe("[가상 추세] 진입: 롱 20 XRP");
  expect(o.body).toContain("실제 주문 없음");
  const c = shadowAlert({ who: "fade", what: "close", side: "sell", price: 1.5, size: 20, reason: "take-profit", pnlPct: 1.2, pnlUsd: 0.36 }, "XRP", "USDT");
  expect(c.subject).toBe("[가상 되돌림] 청산 (익절): 숏 20 XRP");
  expect(c.body).toContain("결과 +1.200% (+0.3600 USDT)");
});
