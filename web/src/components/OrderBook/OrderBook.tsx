"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "@/lib/i18n";
import { useVenue } from "@/lib/venue";
import type { SpikeSnapshot } from "@/lib/types";
import TradePanel from "./TradePanel";
import styles from "./OrderBook.module.css";

type Level = [number, number];
interface Depth { bids: Level[]; asks: Level[]; last: { price: number; side: "buy" | "sell" } | null; ts: number }
type View = "both" | "bids" | "asks";

/** Rows fetched per side: enough for a tall column and for grouping by 10 ticks. */
const FETCH = 100;
const POLL_MS = 1000;
const ROW_H = 21;
const MID_H = 40;

/** 12,363 -> 12.4K; 1,234,567 -> 1.23M. */
function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e5) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n >= 100 ? String(Math.round(n)) : String(+n.toFixed(2));
}

/** Levels merged into buckets of `step`: bids round down, asks up, so a bucket never crosses the spread. */
function group(levels: Level[], step: number, side: "bid" | "ask"): Level[] {
  const out = new Map<number, number>();
  for (const [p, s] of levels) {
    const k = side === "bid" ? Math.floor(p / step + 1e-9) : Math.ceil(p / step - 1e-9);
    out.set(k, (out.get(k) ?? 0) + s);
  }
  return [...out].sort((a, b) => (side === "bid" ? b[0] - a[0] : a[0] - b[0])).map(([k, s]) => [k * step, s]);
}

/**
 * OKX order book beside the chart: asks over bids, cumulative depth bars, the last trade, and the bid / ask split.
 * Its "order" tab is the hand-trading panel; a price clicked in the book goes into its limit price.
 */
export default function OrderBook({ apiUrl, snap }: { apiUrl: string; snap: SpikeSnapshot | null }) {
  const [tab, setTab] = useState<"book" | "trade">("book");
  const [picked, setPicked] = useState<{ price: number; at: number } | null>(null);
  const venue = useVenue();
  const { t } = useLang();
  const [depth, setDepth] = useState<Depth | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>("both");
  const tick = 10 ** -venue.priceDecimals;
  const steps = [1, 10, 100].map((k) => +(tick * k).toFixed(venue.priceDecimals));
  const [step, setStep] = useState(steps[0]);
  const prevLast = useRef<number | null>(null);
  const [dir, setDir] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const base = apiUrl.replace(/\/+$/, "");
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const r = await fetch(`${base}/book?levels=${FETCH}`);
          if (!r.ok) throw new Error(String(r.status));
          const d = (await r.json()) as Depth;
          if (!stop) { setDepth(d); setFailed(false); }
        } catch {
          if (!stop) setFailed(true);
        }
      }
      if (!stop) timer = setTimeout(load, POLL_MS);
    };
    load();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [apiUrl]);

  // The last trade's direction against the one before (a price, not a blink).
  const last = depth?.last?.price ?? (depth?.bids[0] && depth?.asks[0] ? (depth.bids[0][0] + depth.asks[0][0]) / 2 : null);
  useEffect(() => {
    if (last === null) return;
    if (prevLast.current !== null && last !== prevLast.current) setDir(last > prevLast.current ? "up" : "down");
    prevLast.current = last;
  }, [last]);

  // As many rows as fit the height.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listH, setListH] = useState(600);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setListH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const perSide = view === "both" ? Math.max(3, Math.floor((listH - MID_H) / ROW_H / 2)) : Math.max(3, Math.floor((listH - MID_H) / ROW_H));

  const book = useMemo(() => {
    if (!depth) return null;
    const bids = group(depth.bids, step, "bid").slice(0, perSide);
    const asks = group(depth.asks, step, "ask").slice(0, perSide);
    const cum = (ls: Level[]) => { let s = 0; return ls.map(([p, a]) => ({ p, a, c: (s += a) })); };
    const b = cum(bids), a = cum(asks);
    const max = Math.max(b.at(-1)?.c ?? 0, a.at(-1)?.c ?? 0) || 1;
    const bidSum = b.at(-1)?.c ?? 0, askSum = a.at(-1)?.c ?? 0;
    return { bids: b, asks: a.reverse(), max, bidPct: bidSum + askSum ? (bidSum / (bidSum + askSum)) * 100 : 50 };
  }, [depth, step, perSide]);

  const dec = Math.max(0, Math.round(-Math.log10(step)));
  const px = (p: number) => p.toFixed(dec);
  const row = (r: { p: number; a: number; c: number }, side: "bid" | "ask") => (
    <div key={`${side}${r.p}`} className={styles.row} role="button" tabIndex={0} title={t("book.pick")} onClick={() => { setPicked({ price: r.p, at: Date.now() }); setTab("trade"); }}>
      <span className={styles.bar} style={{ width: `${(r.c / book!.max) * 100}%`, background: side === "bid" ? "var(--buy-bar-dim)" : "var(--sell-bar-dim)" }} />
      <span className={side === "bid" ? styles.bidPx : styles.askPx}>{px(r.p)}</span>
      <span>{compact(r.a)}</span>
      <span>{compact(r.c)}</span>
    </div>
  );

  return (
    <div className={styles.book}>
      <div className={styles.head}>
        <span className={styles.tabs}>
          {(["book", "trade"] as const).map((k) => (
            <button key={k} type="button" className={k === tab ? styles.tabOn : undefined} aria-pressed={k === tab} onClick={() => setTab(k)}>{t(k === "book" ? "book.title" : "trade.title")}</button>
          ))}
        </span>
        {tab === "trade" ? null : <select className={styles.step} value={step} onChange={(e) => setStep(Number(e.target.value))} aria-label={t("book.step")}>
          {steps.map((s) => <option key={s} value={s}>{s.toFixed(Math.max(0, Math.round(-Math.log10(s))))}</option>)}
        </select>}
      </div>
      {tab === "trade" ? <TradePanel apiUrl={apiUrl} snap={snap} pickedPrice={picked} /> : <>
      <div className={styles.views} role="group" aria-label={t("book.view")}>
        {(["both", "bids", "asks"] as View[]).map((v) => (
          <button key={v} type="button" className={v === view ? styles.viewOn : undefined} aria-pressed={v === view} onClick={() => setView(v)}>{t(`book.${v}`)}</button>
        ))}
      </div>
      <div className={styles.cols}>
        <span>{t("book.price", { ccy: venue.quoteCcy })}</span>
        <span>{t("book.amount", { base: venue.base })}</span>
        <span>{t("book.total", { base: venue.base })}</span>
      </div>
      <div ref={listRef} className={styles.list}>
        {!book ? (
          <div className={styles.empty}>{failed ? t("book.unavailable") : t("book.loading")}</div>
        ) : (
          <>
            {view !== "bids" ? book.asks.map((r) => row(r, "ask")) : null}
            <div className={styles.mid}>
              <span className={styles.last} style={{ color: dir === "down" ? "var(--sell-ink)" : dir === "up" ? "var(--buy-ink)" : "var(--ink)" }}>
                {last !== null ? venue.fmtMid(last) : "-"}
                {dir ? <span className={styles.arrow}>{dir === "up" ? "↑" : "↓"}</span> : null}
              </span>
              {depth?.bids[0] && depth?.asks[0] ? <span className={styles.spread}>{t("book.spread", { n: (depth.asks[0][0] - depth.bids[0][0]).toFixed(venue.priceDecimals) })}</span> : null}
            </div>
            {view !== "asks" ? book.bids.map((r) => row(r, "bid")) : null}
          </>
        )}
      </div>
      {book ? (
        <div className={styles.ratio}>
          <span className={styles.ratioB}>B</span>
          <span className={styles.ratioBid}>{book.bidPct.toFixed(1)}%</span>
          <span className={styles.ratioBar}>
            <span style={{ width: `${book.bidPct}%`, background: "var(--buy-bar)" }} />
            <span style={{ width: `${100 - book.bidPct}%`, background: "var(--sell-bar)" }} />
          </span>
          <span className={styles.ratioAsk}>{(100 - book.bidPct).toFixed(1)}%</span>
          <span className={styles.ratioS}>S</span>
        </div>
      ) : null}
      </>}
    </div>
  );
}
