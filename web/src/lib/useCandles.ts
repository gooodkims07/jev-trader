"use client";

import { useEffect, useState } from "react";

export interface Candle { ts: number; o: number; h: number; l: number; c: number }

/** OKX bar names by length in seconds (the chart's interval buttons). */
export const BAR_NAMES: Record<number, string> = { 60: "1m", 180: "3m", 300: "5m", 900: "15m", 1800: "30m", 3600: "1H" };

/** Candles of `barSec` from the bot (GET /candles), oldest first, polled every 3 s while the tab is visible. */
export function useCandles(apiUrl: string | undefined, barSec: number, enabled: boolean, limit = 300): Candle[] | null {
  const [candles, setCandles] = useState<{ bar: number; list: Candle[] } | null>(null);
  useEffect(() => {
    if (!enabled || !apiUrl || !BAR_NAMES[barSec]) return;
    const base = apiUrl.replace(/\/+$/, "");
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch(`${base}/candles?bar=${BAR_NAMES[barSec]}&limit=${limit}`);
          if (r.ok) { const list = (await r.json()) as Candle[]; if (!stop && Array.isArray(list)) setCandles({ bar: barSec, list }); }
        } catch { /* keep the last ones */ }
      }
      if (!stop) timer = setTimeout(load, 3000);
    };
    load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [apiUrl, barSec, enabled, limit]);
  // Candles of another interval (just switched) are not shown.
  return candles && candles.bar === barSec ? candles.list : null;
}
