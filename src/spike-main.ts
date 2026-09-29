/** STRATEGY=spike: wire the SpikeTrader to the server and the clock. index.ts hands over here. */
import { config } from "./config";
import { startServer } from "./server";
import { SpikeTrader, createSpikeModel } from "./spike";
import { instrumentHandler, settingsHandler, tokenOk } from "./settings";
import type { Venue } from "./venue";

export async function runSpike(venue: Venue) {
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
      // POST with the admin token: move Jev's open position to the take-profit and stop of the current settings.
      "/spike/exits": async (req) => {
        if (req.method !== "POST") return { status: 405, body: { error: "POST" } };
        if (!config.adminToken) return { status: 403, body: { error: "read-only: start the server with ADMIN_TOKEN" } };
        if (!tokenOk(req)) return { status: 401, body: { error: "wrong or missing admin token" } };
        const r = await trader.applyExits();
        return r ? { status: 200, body: r } : { status: 409, body: { error: "no open position" } };
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
    console.log(`${why}: closing Jev's position and stopping`);
    await trader.shutdown().catch((e) => console.error(`shutdown: ${(e as Error).message}`));
    await venue.shutdown?.().catch(() => {});
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void stop(sig));
  trader.onHalt = (reason) => void stop(reason);
  await trader.warmUp();
  venue.startClock((block) => trader.onBlock(block));
}
