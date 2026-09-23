"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Meta, VenueInfo } from "./types";

/** What an older server (no `venue` in meta) is: the Kuru demo. */
export const KURU: VenueInfo = {
  name: "kuru",
  label: "Kuru",
  market: "",
  symbol: "MON-USDC",
  base: "MON",
  quoteCcy: "USDC",
  priceDecimals: 6,
  sizeDecimals: 1,
  clock: "block",
  txUrl: "https://monadvision.com/tx/",
};

export interface VenueView extends VenueInfo {
  /** "MON/USDC" */
  pair: string;
  /** Formats a mid (or any price between two levels). */
  fmtMid: (n: number) => string;
}

/**
 * Kuru mids print as they always have. Elsewhere a mid can sit half a price unit off the grid (34.95 on a
 * 0.1 KRW book, 2136.5 on a 1 KRW book), so it gets one more decimal, shown only when it is not zero.
 */
export function fmtMid(n: number, v: VenueInfo): string {
  const x = Number.isFinite(n) ? n : 0;
  if (v.name === "kuru") return x.toFixed(v.priceDecimals);
  const s = x.toFixed(v.priceDecimals + 1);
  if (!s.endsWith("0")) return s;
  const cut = s.slice(0, -1);
  return cut.endsWith(".") ? cut.slice(0, -1) : cut;
}

export function venueOf(meta: Meta | null): VenueView {
  const v = meta?.venue ?? KURU;
  return {
    ...v,
    pair: v.symbol.replace("-", "/"),
    fmtMid: (n) => fmtMid(n, v),
  };
}

const VenueContext = createContext<VenueView>(venueOf(null));

export function VenueProvider({ meta, children }: { meta: Meta | null; children: ReactNode }) {
  // One object per meta, so charts that depend on the venue do not recompute on every render.
  const venue = useMemo(() => venueOf(meta), [meta]);
  return <VenueContext.Provider value={venue}>{children}</VenueContext.Provider>;
}

export const useVenue = () => useContext(VenueContext);
