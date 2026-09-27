/** STRATEGY=spike: wire the SpikeTrader to the server and the clock. index.ts hands over here. */
import { config } from "./config";
import { startServer } from "./server";
import { SpikeTrader, createSpikeModel } from "./spike";
import { instrumentHandler, settingsHandler } from "./settings";
import type { Venue } from "./venue";

export async function runSpike(venue: Venue) {
  const { info } = venue;
  const model = createSpikeModel(info);
  const px = (p: number) => p.toFixed(info.priceDecimals);
  const server = startServer(
    { model: model.name, wallet: venue.account, dryRun: !venue.live, market: info.market, venue: info, startedAt: Date.now(), strategy: "spike" },
    () => trader.history,
    { "/spike": () => trader.snapshot() },
    { "/settings": settingsHandler(venue), "/instrument": instrumentHandler(venue, () => trader.closeAllForSwitch()) },
  );
  let lastBeat = 0;
  const trader = new SpikeTrader(venue, model, (e, note) => {
    server.broadcast(e);
    // Quiet unless something happened; a heartbeat every 5 minutes.
    if (note) console.log(`#${e.block} ${px(e.mid)} ${note} · pnl ${e.totals.pnlUsd} ${info.quoteCcy}`);
    else if (Date.now() - lastBeat > 300_000) { lastBeat = Date.now(); console.log(`#${e.block} ${px(e.mid)} waiting for a spike · position ${e.position.side} · pnl ${e.totals.pnlUsd} ${info.quoteCcy}`); }
  }, (block, fill) => server.broadcastFill(block, fill));
  console.log(`jev-trader · ${info.label} · model=${model.name} · ${info.market} · ${venue.live ? "LIVE" : "DRY RUN"} · ${trader.describe()} · :${config.port}`);
  venue.startClock((block) => trader.onBlock(block));
}
