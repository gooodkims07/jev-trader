import { config } from "./config";
import { createModel } from "./model";
import { Trader } from "./trader";
import { startServer } from "./server";
import type { Venue } from "./venue";

const venue: Venue = config.venue === "okx" ? new (await import("./okx")).OkxVenue() : new (await import("./market")).KuruVenue();
await venue.init();
const model = createModel(venue.info);
const { info } = venue;
const px = (p: number) => p.toFixed(info.priceDecimals);
// Off Kuru a mid can sit half a price unit off the grid (0.024425 on a 0.00001 book): one more decimal, shown only when not zero.
const pxMid = (p: number) => (info.name === "kuru" ? px(p) : p.toFixed(info.priceDecimals + 1).replace(/0$/, "").replace(/\.$/, ""));

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
      const quote = !q && e.decision.action === "hold" ? ` SKIP h${(p.hold * 100).toFixed(0)}` : !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${px(q.price)}${q.close ? ` close(${q.close})` : q.capped ? " capped" : ""}${q.overSkip ? ` over-skip h${(p.hold * 100).toFixed(0)}` : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash ?? q.ref}`}`;
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

const where = info.name === "kuru" ? `market ${info.market} · read ${config.readRpcUrl}` : `market ${info.market} · ${config.okx.tickMs} ms ticks${venue.live && config.okx.demo ? " · OKX demo trading" : ""}`;
console.log(`jev-trader · ${info.label} · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} ${info.clock}s · ${venue.live ? `account ${venue.account}` : "DRY RUN"} · ${where} · :${config.port}`);
const r = config.risk;
if (r.sessionStopLoss || r.sessionTakeProfit || r.positionStopPct || r.positionTakePct)
  console.log(`risk · session stop -${r.sessionStopLoss || "off"} take +${r.sessionTakeProfit || "off"} ${info.quoteCcy} · position stop ${r.positionStopPct || "off"}% take ${r.positionTakePct || "off"}% · closes with reduce-only post-only orders`);
// A session stop or take-profit closed the position: shut down as on Ctrl-C (cancel our orders, report any position).
trader.onHalt = (reason) => {
  console.log(`${reason}: position closed, stopping`);
  process.kill(process.pid, "SIGINT");
};
venue.startClock((block) => trader.onBlock(block));

// Take our orders off the book on the way out (OKX). A second signal exits at once.
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, async () => {
    if (stopping || !venue.shutdown || !venue.live) process.exit(0);
    stopping = true;
    console.log(`${sig}: cancelling open orders`);
    await venue.shutdown().catch((e) => console.warn(`shutdown: ${(e as Error).message}`));
    process.exit(0);
  });
