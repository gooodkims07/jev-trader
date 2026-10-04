"use client";

import DecisionPanel from "@/components/DecisionPanel/DecisionPanel";
import Feed from "@/components/Feed/Feed";
import FlowChart from "@/components/FlowChart/FlowChart";
import Header from "@/components/Header/Header";
import StatsRow from "@/components/StatsRow/StatsRow";
import { useFeed } from "@/lib/useFeed";
import { useSpike } from "@/lib/useSpike";
import SpikeStatus from "@/components/Spike/SpikeStatus";
import SpikeCompare from "@/components/Spike/SpikeCompare";
import SpikeList from "@/components/Spike/SpikeList";
import PnlCurve from "@/components/Spike/PnlCurve";
import { VenueProvider } from "@/lib/venue";
import { LangProvider } from "@/lib/i18n";
import SettingsPanel from "@/components/Settings/SettingsPanel";
import OrderBook from "@/components/OrderBook/OrderBook";
import { adminToken, useTradeInfo } from "@/lib/useTradeInfo";
import type { ChartLevel } from "@/components/FlowChart/FlowChart";
import { useState } from "react";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://jev-trader-production.up.railway.app";

export default function Page() {
  const feed = useFeed(API_URL);
  const spikeMode = feed.meta?.strategy === "spike";
  const spike = useSpike(API_URL, spikeMode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const live = spikeMode && feed.meta?.venue?.name === "okx" && !feed.meta?.dryRun;
  const trade = useTradeInfo(API_URL, live);
  // Lines on the chart: resting orders, and Jev's position (entry, take-profit, stop).
  const jevOpen = spike?.open.find((o) => o.who === "jev");
  const levels: ChartLevel[] = [
    ...(trade.info?.orders ?? []).filter((o) => o.price > 0).map((o) => ({ key: o.ordId, price: o.price, kind: o.side, size: o.size - o.filled, draggable: o.manual })),
    ...(jevOpen ? [
      { key: "entry", price: jevOpen.entry, kind: "entry" as const, size: jevOpen.size ?? 0, side: jevOpen.side },
      { key: "tp", price: jevOpen.tp, kind: "tp" as const, draggable: live },
      { key: "sl", price: jevOpen.sl, kind: "sl" as const, draggable: live },
    ] : []),
  ];
  // A dragged line: an order line amends the order's price; the take-profit or stop line moves that exit on OKX.
  const [levelNote, setLevelNote] = useState<{ ok: boolean; text: string; key?: string } | null>(null);
  const onLevelDrag = async (lv: ChartLevel, price: number, opts: { shift: boolean }) => {
    const token = adminToken();
    const say = (ok: boolean, text: string, key?: string) => { setLevelNote({ ok, text, key }); setTimeout(() => setLevelNote(null), 6000); };
    if (!token) return say(false, "no admin token");
    const base = API_URL.replace(/\/+$/, "");
    // A stop may only be tightened; Shift held at the drop asks to widen it.
    const [path, body] = lv.kind === "tp" || lv.kind === "sl" ? ["/spike/exits", { [lv.kind]: price, ...(lv.kind === "sl" && opts.shift ? { allowWiden: true } : {}) }] : ["/trade/amend", { ordId: lv.key, price }];
    try {
      const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const res = await r.json();
      const err = String(res.error ?? r.status);
      say(r.ok, r.ok ? price.toFixed(feed.meta?.venue?.priceDecimals ?? 4) : err, !r.ok && err.startsWith("widen") ? "level.widen" : undefined);
      trade.reload();
    } catch { say(false, "network"); }
  };
  // Kuru is the public demo: English, no controls. OKX: Korean by default, with settings.
  const isKuru = !feed.meta?.venue || feed.meta.venue.name === "kuru";

  return (
    <VenueProvider meta={feed.meta}>
    <LangProvider fallback={isKuru ? "en" : "ko"}>
    {/* The spike dashboard uses the screen's width (up to 1880 px); the Kuru demo keeps its 1400 px card. */}
    <div className="card" style={spikeMode ? { maxWidth: "min(1880px, calc(100% - 32px))" } : undefined}>
      <Header meta={feed.meta} latest={feed.latest} connection={feed.connection} onSettings={isKuru ? undefined : () => setSettingsOpen(true)} />
      <StatsRow latest={feed.latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      <div className={styles.main}>
        <div className={styles.left}>
          {spikeMode && !isKuru ? (
            // OKX spike: the order book beside the chart.
            <div className={`${styles.chartWrap} ${styles.chartWrapControls} ${styles.chartRow}`}>
              <div className={styles.chartMain}>
                <FlowChart events={feed.events} latest={feed.latest} levels={levels} onLevelDrag={onLevelDrag} levelNote={levelNote} />
              </div>
              <div className={styles.bookCol}>
                <OrderBook apiUrl={API_URL} snap={spike} trade={trade} />
              </div>
            </div>
          ) : (
            <div className={isKuru ? styles.chartWrap : `${styles.chartWrap} ${styles.chartWrapControls}`}>
              <FlowChart events={feed.events} latest={feed.latest} />
            </div>
          )}
          {spikeMode ? <PnlCurve snap={spike} /> : null}
        </div>
        {spikeMode ? (
          <div className={`${styles.right} ${styles.rightSpike}`}>
            <div>
              <SpikeStatus snap={spike} apiUrl={API_URL} />
              <SpikeCompare snap={spike} />
            </div>
            <SpikeList snap={spike} />
          </div>
        ) : (
          <div className={styles.right}>
            <DecisionPanel latest={feed.latest} />
            <Feed events={feed.events} />
          </div>
        )}
      </div>
    </div>
    {settingsOpen ? <SettingsPanel apiUrl={API_URL} onClose={() => setSettingsOpen(false)} /> : null}
    </LangProvider>
    </VenueProvider>
  );
}
