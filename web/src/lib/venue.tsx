"use client";

import { createContext, useContext, type ReactNode } from "react";
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
  /**
   * Mids sit half a price unit off the grid on a coarse book, so they get one more decimal there. Not
   * when prices are whole numbers (KRW-BTC moves in 1,000 KRW units): the half unit is still whole.
   */
  midDecimals: number;
}

export function venueOf(meta: Meta | null): VenueView {
  const v = meta?.venue ?? KURU;
  return {
    ...v,
    pair: v.symbol.replace("-", "/"),
    midDecimals: v.name === "kuru" || v.priceDecimals === 0 ? v.priceDecimals : v.priceDecimals + 1,
  };
}

const VenueContext = createContext<VenueView>(venueOf(null));

export function VenueProvider({ meta, children }: { meta: Meta | null; children: ReactNode }) {
  return <VenueContext.Provider value={venueOf(meta)}>{children}</VenueContext.Provider>;
}

export const useVenue = () => useContext(VenueContext);
