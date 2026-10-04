/** STRATEGY=spike: wire the SpikeTrader to the server and the clock. index.ts hands over here. */
import { config } from "./config";
import { startServer } from "./server";
import { SpikeTrader, createSpikeModel, type ShadowEvent } from "./spike";
import { instrumentHandler, settingsHandler, tokenOk } from "./settings";
import type { Venue } from "./venue";
import { Alerts } from "./alerts";
import { buildBrief } from "./brief";
import { AccountWatch } from "./watch";
import { OkxApi } from "./okx-api";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { BlockEvent } from "./trader";

const REASON_KO: Record<string, string> = { "take-profit": "익절", "stop-loss": "손절", time: "시간 만료", manual: "수동 청산", reverse: "반대 전환", switch: "코인 변경", shutdown: "봇 종료", "session-stop": "세션 손절", "session-take": "세션 익절" };

/** A bot note worth telling the office about, as an alert (subject in Korean, the note itself in the body); else null. */
const SHADOW_KO: Record<ShadowEvent["who"], string> = { fade: "되돌림", follow: "추종", trend: "추세" };

/** A shadow strategy's trade as an alert, marked virtual (가상) in the subject and body: no money moved. */
export function shadowAlert(e: ShadowEvent, base: string, ccy: string, priceDecimals = 4): { subject: string; body: string } {
  const name = SHADOW_KO[e.who], side = e.side === "buy" ? "롱" : "숏", px = e.price.toFixed(priceDecimals);
  const what = e.what === "open" ? "진입" : e.what === "add" ? "추가 매수" : `청산 (${REASON_KO[e.reason ?? ""] ?? e.reason})`;
  const result = e.what === "close" ? `, 결과 ${(e.pnlPct ?? 0) >= 0 ? "+" : ""}${(e.pnlPct ?? 0).toFixed(3)}% (${(e.pnlUsd ?? 0) >= 0 ? "+" : ""}${(e.pnlUsd ?? 0).toFixed(4)} ${ccy})` : "";
  return {
    subject: `[가상 ${name}] ${what}: ${side} ${e.size} ${base}`,
    body: `비교용 가상 거래(shadow, 실제 주문 없음)입니다. ${name} 전략이 ${side} ${e.size} ${base}를 ${px}에 ${what}했습니다${result}.`,
  };
}

export function alertFor(note: string, e: BlockEvent, base: string, ccy: string, priceDecimals = 4): { kind: string; subject: string; body: string } | null {
  const pos = e.position.side === "flat" ? "포지션 없음" : `${e.position.side === "long" ? "롱" : "숏"} ${e.position.size} ${base}`;
  // Long prices in the note (an average entry) at the tick.
  const tidy = note.replace(/\d+\.\d{6,}/g, (x) => Number(x).toFixed(priceDecimals));
  const body = `${tidy}\n현재가 ${e.mid.toFixed(priceDecimals)}, ${pos}, 세션 손익 ${e.totals.pnlUsd} ${ccy}`;
  if (note.startsWith("EXIT ")) {
    const reason = note.split(" ")[1] ?? "";
    return { kind: "exit", subject: `[spike] EXIT ${reason} (${REASON_KO[reason] ?? reason})`, body };
  }
  if (note.startsWith("session-stop") || note.startsWith("session-take")) {
    const kind = note.startsWith("session-stop") ? "session-stop" : "session-take";
    return { kind: "halt", subject: `[spike] ${kind}, 봇 정지`, body };
  }
  if (note.startsWith("MANUAL ")) return { kind: "manual", subject: note.includes("taken over") ? "[spike] 수동 포지션 인계" : "[spike] 수동 추가 매수 반영", body };
  const m = note.match(/^SPIKE .*: (open|add|reverse)\b/);
  if (m) return { kind: "entry", subject: `[spike] 진입: ${({ open: "새 포지션", add: "추가 매수", reverse: "반대 전환" } as Record<string, string>)[m[1]!]}`, body };
  return null;
}

export async function runSpike(venue: Venue) {
  // The coin-trade office reads these (GET /alerts?after=<id>).
  const alerts = new Alerts();
  /** Hand trading needs a live venue that supports it, the method, and the admin token. */
  const guard = (req: Request, method: string): { status: number; body: unknown } | null => {
    if (req.method !== method) return { status: 405, body: { error: method } };
    if (!venue.manual) return { status: 409, body: { error: "hand trading needs a live OKX account (not a dry run)" } };
    if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN" } };
    if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
    return null;
  };
  const { info } = venue;
  const model = createSpikeModel(info);
  const px = (p: number) => p.toFixed(info.priceDecimals);
  const server = startServer(
    { model: model.name, wallet: venue.account, dryRun: !venue.live, market: info.market, venue: info, startedAt: Date.now(), strategy: "spike" },
    () => trader.history,
    { "/spike": () => trader.snapshot() },
    {
      "/settings": settingsHandler(venue),
      "/instrument": instrumentHandler(venue, () => trader.closeAllForSwitch()),
      // POST with the admin token: measure the next spike from the current price.
      "/spike/reset": async (req) => {
        if (req.method !== "POST") return { status: 405, body: { error: "POST" } };
        if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN" } };
        if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
        return { status: 200, body: { reference: trader.resetReference() } };
      },
      // POST with the admin token: send the market brief to the office now (it also goes daily at BRIEF_HOUR).
      "/alerts/brief": async (req) => {
        if (req.method !== "POST") return { status: 405, body: { error: "POST" } };
        if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN" } };
        if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
        try { return { status: 200, body: await sendBrief() }; } catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
      },
      // GET ?after=<id>: alerts newer than that id, for the coin-trade office.
      "/alerts": async (req) => {
        const after = Number(new URL(req.url).searchParams.get("after") ?? 0) || 0;
        return { status: 200, body: alerts.since(after) };
      },
      // GET ?levels=N: the order book for the dashboard (display only).
      "/book": async (req) => {
        if (!venue.depth) return { status: 404, body: { error: "no order book here" } };
        const levels = Math.min(5000, Number(new URL(req.url).searchParams.get("levels") ?? 30) || 30);
        try { return { status: 200, body: await venue.depth(levels) }; } catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
      },
      // Hand trading from the dashboard (live OKX, admin token): GET the panel's data, POST an order or a cancel.
      "/trade": async (req) => {
        const denied = guard(req, "GET");
        if (denied) return denied;
        try { return { status: 200, body: { ...(await venue.manual!.info()), manualToday: trader.manualPnlToday(), manualDailyLimit: config.risk.manualDailyLossLimit } }; } catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
      },
      "/trade/order": async (req) => {
        const denied = guard(req, "POST");
        if (denied) return denied;
        let b: Record<string, unknown>;
        try { b = (await req.json()) as Record<string, unknown>; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
        const side = b.side, type = b.type, size = Number(b.size), price = b.price === undefined ? undefined : Number(b.price);
        const refuse = (error: string) => {
          console.warn(`manual order refused (${JSON.stringify(b)}): ${error}`);
          alerts.add("refused", "[spike] 수동 주문 거부", `대시보드 주문이 거부되었습니다(refused): ${b.side} ${b.type} ${b.size} ${venue.info.base}${b.price ? ` @ ${b.price}` : ""}${b.reduceOnly ? " 감소 전용" : ""}\n사유: ${error}`);
          return { status: 400, body: { error } };
        };
        const tpPct = b.tpPct === undefined ? null : Number(b.tpPct), slPct = b.slPct === undefined ? null : Number(b.slPct);
        if (side !== "buy" && side !== "sell") return refuse("side must be buy or sell");
        if (type !== "limit" && type !== "market") return refuse("type must be limit or market");
        if (!(size > 0)) return refuse("amount must be above 0");
        if (type === "limit" && !b.bbo && !(price! > 0)) return refuse("a limit order needs a price");
        if ((tpPct !== null || slPct !== null) && !(tpPct! > 0 && tpPct! <= 50 && slPct! > 0 && slPct! <= 50)) return refuse("take-profit and stop must both be between 0 and 50%");
        try {
          // Safety, for anything but reduce-only:
          // - the daily limit: once today's manual P&L is at or below -RISK_MANUAL_DAILY_LOSS_LIMIT, no new entries today;
          // - the position limit: the whole position after the order (not just this order) may use at most
          //   RISK_MANUAL_MAX_MARGIN_PCT of the equity as margin, so splitting an order does not get round it.
          if (!b.reduceOnly) {
            const limit = config.risk.manualDailyLossLimit, today = trader.manualPnlToday();
            if (limit > 0 && today <= -limit) return refuse(`daily limit: today's manual P&L is ${today.toFixed(2)} USDT, at or past -${limit} USDT; no new manual entries until tomorrow (reduce-only and closing still work)`);
            const info = await venue.manual!.info();
            const px = type === "limit" && !b.bbo ? price! : side === "buy" ? info.ask : info.bid;
            const pos = info.position.size, same = pos === 0 || (side === "buy") === (pos > 0);
            const after = same ? Math.abs(pos) + size : Math.max(0, size - Math.abs(pos)); // position size after the order
            const margin = (after * px) / info.leverage;
            const cap = (info.equity * info.maxMarginPct) / 100;
            const room = Math.max(0, Math.floor((cap * info.leverage) / px - (same ? Math.abs(pos) : 0)) + (same ? 0 : Math.abs(pos)));
            if (after > Math.abs(pos) && margin > cap + 1e-9) return refuse(`position limit: the position after this order would need ${margin.toFixed(2)} USDT margin, over ${info.maxMarginPct}% of equity = ${cap.toFixed(2)} USDT (this order: at most about ${room} ${venue.info.base})`);
          }
          const r = await venue.manual!.place({ side, type, price, bbo: !!b.bbo, size, reduceOnly: !!b.reduceOnly });
          if (tpPct !== null && slPct !== null && !b.reduceOnly) trader.noteManualExits(r.ordId, tpPct, slPct);
          return { status: 200, body: r };
        } catch (e) {
          return refuse((e as Error).message);
        }
      },
      "/trade/amend": async (req) => {
        const denied = guard(req, "POST");
        if (denied) return denied;
        let b: { ordId?: unknown; price?: unknown };
        try { b = (await req.json()) as { ordId?: unknown; price?: unknown }; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
        if (typeof b.ordId !== "string" || !/^\d+$/.test(b.ordId)) return { status: 400, body: { error: "ordId" } };
        try { await venue.manual!.amend(b.ordId, Number(b.price)); return { status: 200, body: { ok: true } }; } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
      },
      // Close the position at market now: all, or a share of it (reduce-only, so it can never open the other way).
      "/trade/close": async (req) => {
        const denied = guard(req, "POST");
        if (denied) return denied;
        let b: { fraction?: unknown };
        try { b = (await req.json()) as { fraction?: unknown }; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
        const fraction = Number(b.fraction);
        if (![0.1, 0.25, 0.5, 0.75, 1].includes(fraction)) return { status: 400, body: { error: "fraction must be 0.1, 0.25, 0.5, 0.75 or 1" } };
        try {
          const info = await venue.manual!.info();
          const pos = info.position.size;
          if (!pos) return { status: 409, body: { error: "no position to close" } };
          // All: the exact size. A share: rounded down to the lot, at least one lot, at most the position.
          const size = fraction === 1 ? Math.abs(pos) : Math.min(Math.abs(pos), Math.max(info.lot, Math.floor((Math.abs(pos) * fraction) / info.lot + 1e-9) * info.lot));
          const r = await venue.manual!.place({ side: pos > 0 ? "sell" : "buy", type: "market", size: +size.toFixed(8), reduceOnly: true });
          console.log(`manual close ${fraction * 100}%: ${r.filled} of ${Math.abs(pos)} ${venue.info.base} at ${r.avgPx}`);
          return { status: 200, body: { ...r, position: pos } };
        } catch (e) {
          console.warn(`manual close refused: ${(e as Error).message}`);
          alerts.add("refused", "[spike] 시장가 청산 거부", `대시보드 ${fraction * 100}% 청산이 거부되었습니다(refused).\n사유: ${(e as Error).message}`);
          return { status: 400, body: { error: (e as Error).message } };
        }
      },
      "/trade/cancel": async (req) => {
        const denied = guard(req, "POST");
        if (denied) return denied;
        let b: { ordId?: unknown };
        try { b = (await req.json()) as { ordId?: unknown }; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
        if (typeof b.ordId !== "string" || !/^\d+$/.test(b.ordId)) return { status: 400, body: { error: "ordId" } };
        try { await venue.manual!.cancel(b.ordId); return { status: 200, body: { ok: true } }; } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
      },
      // POST with the admin token: move Jev's open position to the take-profit and stop of the current settings.
      "/spike/exits": async (req) => {
        if (req.method !== "POST") return { status: 405, body: { error: "POST" } };
        if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN" } };
        if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
        // Optional body { tp?, sl?, allowWiden? }: those prices (a line dragged on the chart); none: the settings' levels.
        let at: { tp?: number; sl?: number; allowWiden?: boolean } | undefined;
        const text = await req.text();
        if (text.trim()) {
          try { const b = JSON.parse(text) as { tp?: unknown; sl?: unknown; allowWiden?: unknown }; at = { ...(b.tp !== undefined ? { tp: Number(b.tp) } : {}), ...(b.sl !== undefined ? { sl: Number(b.sl) } : {}) }; if (b.allowWiden === true) at.allowWiden = true; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
          if ([at.tp, at.sl].some((v) => v !== undefined && !(v > 0))) return { status: 400, body: { error: "prices must be above 0" } };
        }
        try {
          const r = await trader.applyExits(at);
          return r ? { status: 200, body: r } : { status: 409, body: { error: "no open position" } };
        } catch (e) { return { status: 400, body: { error: (e as Error).message } }; }
      },
    },
  );
  let lastBeat = 0;
  const trader = new SpikeTrader(venue, model, (e, note) => {
    server.broadcast(e);
    // Quiet unless something happened; a heartbeat every 5 minutes.
    if (note) {
      console.log(`#${e.block} ${px(e.mid)} ${note} · pnl ${e.totals.pnlUsd} ${info.quoteCcy}`);
      const a = alertFor(note, e, info.base, info.quoteCcy, info.priceDecimals);
      if (a) alerts.add(a.kind, a.subject, a.body);
    }
    else if (Date.now() - lastBeat > 300_000) { lastBeat = Date.now(); console.log(`#${e.block} ${px(e.mid)} waiting for a spike · position ${e.position.side} · pnl ${e.totals.pnlUsd} ${info.quoteCcy}`); }
  }, (block, fill) => server.broadcastFill(block, fill));
  // The daily market brief: once a day at BRIEF_HOUR (local time); the day it went out is kept across restarts.
  const BRIEF_STATE = "data/brief.json";
  const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local
  const sendBrief = async () => {
    const b = await buildBrief(info.market, info.priceDecimals);
    const a = alerts.add("brief", b.subject, b.body, "시황 리포트");
    try { writeFileSync(BRIEF_STATE, JSON.stringify({ last: today() })); } catch { /* sent anyway */ }
    console.log(`market brief sent: ${b.subject}`);
    return a;
  };
  setInterval(() => {
    if (config.briefHour < 0 || new Date().getHours() !== config.briefHour) return;
    let last = "";
    try { if (existsSync(BRIEF_STATE)) last = (JSON.parse(readFileSync(BRIEF_STATE, "utf8")) as { last?: string }).last ?? ""; } catch { /* none yet */ }
    if (last !== today()) sendBrief().catch((e) => console.warn(`market brief: ${(e as Error).message}`));
  }, 60_000);

  // Live OKX: watch the account once a minute (stops, liquidation distance, balance, ledger, withdrawals).
  if (venue.live && info.name === "okx") {
    const api = new OkxApi(config.okx.apiKey, config.okx.secretKey, config.okx.passphrase, config.okx.demo, 8000);
    api.syncTime().catch(() => {}).finally(() => new AccountWatch(api, alerts, { instId: info.market, base: info.base, priceDecimals: info.priceDecimals }).start());
  }

  trader.onShadow = (e) => { const a = shadowAlert(e, info.base, info.quoteCcy, info.priceDecimals); alerts.add("shadow", a.subject, a.body, "jev-trader 봇 (가상)"); };
  console.log(`jev-trader · ${info.label} · model=${model.name} · ${info.market} · ${venue.live ? "LIVE" : "DRY RUN"} · ${trader.describe()} · :${config.port}`);
  alerts.add("start", "[spike] 봇 시작", `봇이 ${venue.live ? "실거래" : "모의"}로 시작했습니다. ${info.market}, ${trader.describe()}`);

  // Leaving never strands a live position: close Jev's at market, cancel our orders and exits, then exit.
  // Exit 0 (not 75), so scripts/run.sh stops too. A session stop or take-profit ends the run the same way.
  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) process.exit(0);
    stopping = true;
    // After a session limit a manual position stays (only Jev's own P&L counts toward the limits).
    const keepManual = why.startsWith("session-");
    console.log(`${why}: closing Jev's position${keepManual ? " (a manual one stays)" : ""} and stopping`);
    await trader.shutdown({ keepManual }).catch((e) => console.error(`shutdown: ${(e as Error).message}`));
    await venue.shutdown?.().catch(() => {});
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop(sig));
  trader.onHalt = (reason) => void stop(reason);
  await trader.warmUp();
  venue.startClock((block) => trader.onBlock(block));
}
