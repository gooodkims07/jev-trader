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
import { useState } from "react";
import styles from "./page.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "https://jev-trader-production.up.railway.app";

export default function Page() {
  const feed = useFeed(API_URL);
  const spikeMode = feed.meta?.strategy === "spike";
  const spike = useSpike(API_URL, spikeMode);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Kuru is the public demo: English, no controls. OKX: Korean by default, with settings.
  const isKuru = !feed.meta?.venue || feed.meta.venue.name === "kuru";

  return (
    <VenueProvider meta={feed.meta}>
    <LangProvider fallback={isKuru ? "en" : "ko"}>
    <div className="card">
      <Header meta={feed.meta} latest={feed.latest} connection={feed.connection} onSettings={isKuru ? undefined : () => setSettingsOpen(true)} />
      <StatsRow latest={feed.latest} avgLatencyMs={feed.avgLatencyMs} meta={feed.meta} />
      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.chartWrap}>
            <FlowChart events={feed.events} latest={feed.latest} />
          </div>
          {spikeMode ? <PnlCurve snap={spike} /> : null}
        </div>
        {spikeMode ? (
          <div className={styles.right}>
            <div>
              <SpikeStatus snap={spike} />
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
