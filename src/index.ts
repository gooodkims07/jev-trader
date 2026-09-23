import { config } from "./config";
import { createModel } from "./model";
import { Trader } from "./trader";
import { startServer } from "./server";
import type { Venue } from "./venue";

const venue: Venue = config.venue === "upbit" ? new (await import("./upbit")).UpbitVenue() : new (await import("./market")).KuruVenue();
await venue.init();
const model = createModel(venue.info.name);
const { info } = venue;
const px = (p: number) => p.toFixed(info.priceDecimals);
const pxMid = (p: number) => p.toFixed(info.priceDecimals + 1); // a mid can sit half a price unit off the grid

const server = startServer(
  { model: model.name, wallet: venue.account, dryRun: !venue.live, market: info.market, venue: info, startedAt: Date.now() },
  () => trader.history,
);
const trader = new Trader(
  venue,
  model,
  (e, t) => {
    server.broadcast(e);
    if (e.decision && !e.decision.late) {
      const p = e.decision.probabilities;
      const q = e.quote;
      const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${px(q.price)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash ?? q.ref}`}`;
      console.log(`#${e.block} ${pxMid(e.mid)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl ${e.totals.pnlUsd} ${info.quoteCcy}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
    }
  },
  (block, fill) => {
    server.broadcastFill(block, fill);
    console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${px(fill.price)}${fill.simulated ? " (sim)" : ` order ${fill.orderId}${fill.txHash ? ` ${fill.txHash}` : ""}`}`);
  },
  (block, quote) => {
    server.broadcastQuote(block, quote);
    if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${px(quote.price)}${quote.txHash ? ` gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}` : ` ${quote.ref}`}`);
  },
);

const where = info.name === "kuru" ? `market ${info.market} · read ${config.readRpcUrl}` : `market ${info.market} · ${config.upbit.tickMs} ms ticks`;
console.log(`jev-trader · ${info.label} · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} ${info.clock}s · ${venue.live ? `account ${venue.account}` : "DRY RUN"} · ${where} · :${config.port}`);
venue.startClock((block) => trader.onBlock(block));
