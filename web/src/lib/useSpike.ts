"use client";

import { useEffect, useState } from "react";
import type { SpikeSnapshot } from "./types";

/** Polls GET /spike every 2 s while `enabled` (the server runs STRATEGY=spike). Keeps the last good snapshot. */
export function useSpike(apiUrl: string, enabled: boolean): SpikeSnapshot | null {
  const [snap, setSnap] = useState<SpikeSnapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const base = (apiUrl || "").replace(/\/+$/, "");
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch(`${base}/spike`, { cache: "no-store" });
        if (r.ok && !stop) setSnap((await r.json()) as SpikeSnapshot);
      } catch {
        /* keep the last snapshot; the next poll retries */
      }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { stop = true; clearInterval(id); };
  }, [apiUrl, enabled]);
  return snap;
}
