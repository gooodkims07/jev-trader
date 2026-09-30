/** STRATEGY=spike: wire the SpikeTrader to the server and the clock. index.ts hands over here. */
import { config } from "./config";
import { startServer } from "./server";
import { SpikeTrader, createSpikeModel } from "./spike";
import { instrumentHandler, settingsHandler, tokenOk } from "./settings";
import type { Venue } from "./venue";

export async function runSpike(venue: Venue) {
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
      // GET ?levels=N: the order book for the dashboard (display only).
      "/book": async (req) => {
        if (!venue.depth) return { status: 404, body: { error: "no order book here" } };
        const levels = Number(new URL(req.url).searchParams.get("levels") ?? 30) || 30;
        try { return { status: 200, body: await venue.depth(levels) }; } catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
      },
      // Hand trading from the dashboard (live OKX, admin token): GET the panel's data, POST an order or a cancel.
      "/trade": async (req) => {
        const denied = guard(req, "GET");
        if (denied) return denied;
        try { return { status: 200, body: await venue.manual!.info() }; } catch (e) { return { status: 502, body: { error: (e as Error).message } }; }
      },
      "/trade/order": async (req) => {
        const denied = guard(req, "POST");
        if (denied) return denied;
        let b: Record<string, unknown>;
        try { b = (await req.json()) as Record<string, unknown>; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
        const side = b.side, type = b.type, size = Number(b.size), price = b.price === undefined ? undefined : Number(b.price);
        const refuse = (error: string) => { console.warn(`manual order refused (${JSON.stringify(b)}): ${error}`); return { status: 400, body: { error } }; };
        const tpPct = b.tpPct === undefined ? null : Number(b.tpPct), slPct = b.slPct === undefined ? null : Number(b.slPct);
        if (side !== "buy" && side !== "sell") return refuse("side must be buy or sell");
        if (type !== "limit" && type !== "market") return refuse("type must be limit or market");
        if (!(size > 0)) return refuse("amount must be above 0");
        if (type === "limit" && !b.bbo && !(price! > 0)) return refuse("a limit order needs a price");
        if ((tpPct !== null || slPct !== null) && !(tpPct! > 0 && tpPct! <= 50 && slPct! > 0 && slPct! <= 50)) return refuse("take-profit and stop must both be between 0 and 50%");
        try {
          // Safety: the margin the order opens (the part beyond closing the position) may use at most
          // RISK_MANUAL_MAX_MARGIN_PCT of the equity.
          if (!b.reduceOnly) {
            const info = await venue.manual!.info();
            const px = type === "limit" && !b.bbo ? price! : side === "buy" ? info.ask : info.bid;
            const pos = info.position.size, closing = (side === "buy" ? pos < 0 : pos > 0) ? Math.abs(pos) : 0;
            const margin = (Math.max(0, size - closing) * px) / info.leverage;
            const cap = (info.equity * info.maxMarginPct) / 100;
            if (margin > cap + 1e-9) return refuse(`margin ${margin.toFixed(2)} USDT is over the limit: ${info.maxMarginPct}% of equity = ${cap.toFixed(2)} USDT (max about ${Math.floor((cap * info.leverage) / px + closing)} ${venue.info.base})`);
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
        // Optional body { tp?, sl? }: those prices (a line dragged on the chart); none: the settings' levels.
        let at: { tp?: number; sl?: number } | undefined;
        const text = await req.text();
        if (text.trim()) {
          try { const b = JSON.parse(text) as { tp?: unknown; sl?: unknown }; at = { ...(b.tp !== undefined ? { tp: Number(b.tp) } : {}), ...(b.sl !== undefined ? { sl: Number(b.sl) } : {}) }; } catch { return { status: 400, body: { error: "body must be JSON" } }; }
          if (Object.values(at).some((v) => !(v! > 0))) return { status: 400, body: { error: "prices must be above 0" } };
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
    if (note) console.log(`#${e.block} ${px(e.mid)} ${note} · pnl ${e.totals.pnlUsd} ${info.quoteCcy}`);
    else if (Date.now() - lastBeat > 300_000) { lastBeat = Date.now(); console.log(`#${e.block} ${px(e.mid)} waiting for a spike · position ${e.position.side} · pnl ${e.totals.pnlUsd} ${info.quoteCcy}`); }
  }, (block, fill) => server.broadcastFill(block, fill));
  console.log(`jev-trader · ${info.label} · model=${model.name} · ${info.market} · ${venue.live ? "LIVE" : "DRY RUN"} · ${trader.describe()} · :${config.port}`);

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
