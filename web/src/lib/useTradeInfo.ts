"use client";

import { useCallback, useEffect, useState } from "react";

export type TradeSide = "buy" | "sell";
export interface OpenOrder { ordId: string; side: TradeSide; type: string; price: number; size: number; filled: number; reduceOnly: boolean; ts: number; manual: boolean }
/** GET /trade (live OKX, admin token): balance, sizing rules, price band, the position and resting orders. */
export interface TradeInfo {
  available: number; leverage: number; marginMode: string; lot: number; min: number; tick: number; mmr: number;
  limits: { buy: number; sell: number } | null; bid: number; ask: number;
  position: { size: number; avgPx: number }; orders: OpenOrder[];
}
/** err: a key of i18n ("trade.noToken", "settings.unauthorized", "trade.unavailable") or the server's message. */
export interface TradeState { info: TradeInfo | null; err: string | null; reload: () => void }

const POLL_MS = 2000;
export const adminToken = () => { try { return localStorage.getItem("jev.adminToken") ?? ""; } catch { return ""; } };

/** Polls /trade every 2 s while the tab is visible and an admin token is saved. Shared by the chart and the order panel. */
export function useTradeInfo(apiUrl: string, enabled: boolean): TradeState {
  const base = apiUrl.replace(/\/+$/, "");
  const [info, setInfo] = useState<TradeInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const token = adminToken();
    if (!token) { setErr("trade.noToken"); setInfo(null); return; }
    try {
      const r = await fetch(`${base}/trade`, { headers: { authorization: `Bearer ${token}` } });
      const body = await r.json();
      if (!r.ok) { setErr(r.status === 401 ? "settings.unauthorized" : body.error ?? String(r.status)); return; }
      setInfo(body as TradeInfo); setErr(null);
    } catch { setErr("trade.unavailable"); }
  }, [base]);
  useEffect(() => {
    if (!enabled) return;
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => { if (document.visibilityState === "visible") await load(); if (!stop) timer = setTimeout(tick, POLL_MS); };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [load, enabled]);
  return { info, err, reload: load };
}
