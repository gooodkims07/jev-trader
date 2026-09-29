"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { BlockEvent } from "@/lib/types";
import { fmtConf, fmtMon, fmtPrice, fmtSigned, fmtSignedMon } from "@/lib/format";
import { useVenue } from "@/lib/venue";
import { useLang } from "@/lib/i18n";
import { smoothPath } from "./smooth";
import styles from "./FlowChart.module.css";

const STEP = 10; // px per block
const ANCHOR_GAP = 88; // newest point sits this far from the right edge
const PAD_TOP = 84; // overlays live here
const PAD_BOTTOM = 72; // block strip + tag clearance
const EASE = 0.1; // scale easing per new block
const MIN_RANGE_PCT = 0.002; // floor of 0.20% of price, so bps noise stays calm
const CELL_W = 6;
const CELL_H = 18;
const TAG_W = 58;
/** OKX chart ranges, in seconds (blocks are seconds there). */
const RANGES = [60, 180, 300, 600, 900, 1800, 3600];
const DEFAULT_RANGE = 300;
/** Seconds between time labels: the first at least 90 px apart. */
const LABEL_EVERY = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
/** RSI panel (OKX): Wilder's RSI over RSI_N candles, the candle sized so about 60 fit the range. Display only. */
const RSI_N = 14;
const RSI_CANDLES = [1, 5, 10, 15, 30, 60];
const RSI_MAX_H = 72;

/** Wilder's RSI of `closes`: one value per close from the RSI_N-th change on (null before). */
function rsiOf(closes: number[]): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  let ag = 0, al = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= RSI_N) {
      ag += g / RSI_N; al += l / RSI_N;
      if (i < RSI_N) continue;
    } else {
      ag = (ag * (RSI_N - 1) + g) / RSI_N; al = (al * (RSI_N - 1) + l) / RSI_N;
    }
    out[i] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function cellFill(e: BlockEvent): string {
  if (e.decision?.late) return "var(--late-cell)";
  const side = e.fill?.side ?? e.decision?.action;
  if (side === "buy") return "var(--buy-bar)";
  if (side === "sell") return "var(--sell-bar)";
  return "var(--hold-cell)";
}

export default function FlowChart({
  events,
  latest,
}: {
  events: BlockEvent[];
  latest: BlockEvent | null;
}) {
  const venue = useVenue();
  const { t } = useLang();
  const clockWord = t(venue.clock === "block" ? "clock.block" : "clock.tick");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const originRef = useRef<number | null>(null);
  const scaleRef = useRef<{ lo: number; hi: number; block: number } | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/[^a-zA-Z0-9]/g, "");

  // OKX only (the Kuru demo stays fixed): the time range shown (buttons, or the wheel stepping through them) and
  // a price zoom that narrows or widens the band (Shift+wheel, or the buttons). Both kept per browser.
  const zoomable = venue.name !== "kuru";
  const [windowSec, setWindowSec] = useState(DEFAULT_RANGE);
  const [yz, setYz] = useState(1);
  const [rsiOn, setRsiOn] = useState(true);
  const toggleRsi = useCallback(() => {
    setRsiOn((on) => {
      try { localStorage.setItem("jev.chartRsi", on ? "0" : "1"); } catch { /* not kept */ }
      return !on;
    });
  }, []);
  useEffect(() => {
    try {
      const r = Number(localStorage.getItem("jev.chartRange"));
      if (RANGES.includes(r)) setWindowSec(r);
      const y = Number(localStorage.getItem("jev.chartZoomY"));
      if (y > 0) setYz(y);
      if (localStorage.getItem("jev.chartRsi") === "0") setRsiOn(false);
    } catch { /* none saved */ }
  }, []);
  const pickRange = useCallback((r: number) => {
    setWindowSec(r);
    try { localStorage.setItem("jev.chartRange", String(r)); } catch { /* not kept */ }
  }, []);
  const zoomY = useCallback((factor: number | null) => {
    setYz((z) => {
      const next = factor === null ? 1 : Math.min(8, Math.max(0.5, z * factor));
      try { localStorage.setItem("jev.chartZoomY", String(next)); } catch { /* not kept */ }
      return next;
    });
  }, []);
  useEffect(() => {
    const el = panelRef.current;
    if (!el || !zoomable) return;
    let acc = 0; // a trackpad sends many small deltas: one range step per 120
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey) { zoomY((e.deltaY || e.deltaX) < 0 ? 1.15 : 1 / 1.15); return; }
      acc += e.deltaY;
      if (Math.abs(acc) < 120) return;
      const dir = acc > 0 ? 1 : -1; // down: longer range
      acc = 0;
      setWindowSec((r) => {
        const i = Math.min(RANGES.length - 1, Math.max(0, RANGES.indexOf(r) + dir));
        try { localStorage.setItem("jev.chartRange", String(RANGES[i])); } catch { /* not kept */ }
        return RANGES[i];
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomable, zoomY]);
  const yzoom = zoomable ? yz : 1;

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize((s) =>
        Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5
          ? s
          : { w: Math.round(r.width), h: Math.round(r.height) },
      );
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;

  const model = useMemo(() => {
    // The RSI panel takes the bottom of the plot when there is room for both.
    const room = h - PAD_TOP - PAD_BOTTOM;
    const rsiH = zoomable && rsiOn ? Math.min(RSI_MAX_H, Math.round(room * 0.3)) : 0;
    const showRsi = rsiH >= 40;
    const plotH = room - (showRsi ? rsiH + 12 : 0);
    if (w < 160 || plotH < 60) return null;

    // Kuru: STEP px per block, as many blocks as fit. OKX: blocks are seconds, and the chosen range fills the width.
    const n = Math.max(2, Math.ceil((w - ANCHOR_GAP) / STEP) + 2);
    let series = zoomable ? events.slice() : events.slice(-n);
    const tail = series[series.length - 1];
    if (latest && (!tail || latest.block > tail.block)) series = [...series, latest];
    else if (latest && tail && latest.block === tail.block) series[series.length - 1] = latest;
    let last = series[series.length - 1];
    if (!last) return null;
    // Block numbers per point: 1 on Kuru; on OKX a 5 s tick moves 5 at a time. The typical gap between recent points.
    const gaps = series.slice(-30).map((e, i, a) => (i ? e.block - a[i - 1].block : 0)).filter((g) => g > 0).sort((a, b) => a - b);
    const span = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1;
    if (zoomable) {
      const from = last.block - windowSec - 2 * span; // one point beyond each edge, so the line runs off it
      series = series.filter((e) => e.block >= from);
      if (series.length < 2) series = events.slice(-2).concat(series).slice(-2);
      last = series[series.length - 1];
    } else series = series.slice(-n);

    if (originRef.current === null) originRef.current = series[0].block;
    const origin = originRef.current;
    const pxPerBlock = zoomable ? (w - ANCHOR_GAP) / windowSec : STEP / span;
    const fx = (b: number) => (b - origin) * pxPerBlock;
    const step = pxPerBlock * span; // px between points

    // --- value scale: window min/max, floored to 0.20% of price, eased 10%/block
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    for (const e of series) {
      if (e.mid < lo) lo = e.mid;
      if (e.mid > hi) hi = e.mid;
      sum += e.mid;
    }
    const mean = sum / series.length;
    const floor = Math.max(mean * MIN_RANGE_PCT, 1e-9);
    if (hi - lo < floor) {
      lo = mean - floor / 2;
      hi = mean + floor / 2;
    }
    const prev = scaleRef.current;
    if (prev) {
      if (prev.block === last.block) {
        lo = prev.lo;
        hi = prev.hi;
      } else {
        lo = prev.lo + (lo - prev.lo) * EASE;
        hi = prev.hi + (hi - prev.hi) * EASE;
      }
      // the eased band must still contain the data: shrink slowly, grow at once
      for (const e of series) {
        if (e.mid < lo) lo = e.mid;
        if (e.mid > hi) hi = e.mid;
      }
      if (hi - lo < floor) {
        const c = (hi + lo) / 2;
        lo = c - floor / 2;
        hi = c + floor / 2;
      }
    }
    scaleRef.current = { lo, hi, block: last.block };
    // Vertical zoom around the middle of the (eased) band; the easing itself stays on the unzoomed band.
    if (yzoom !== 1) {
      const c = (lo + hi) / 2, half = (hi - lo) / 2 / yzoom;
      lo = c - half;
      hi = c + half;
    }

    const range = hi - lo || 1;
    const fy = (p: number) => PAD_TOP + (1 - (p - lo) / range) * plotH;

    const pts = series.map((e) => [fx(e.block), fy(e.mid)] as const);
    const line = smoothPath(pts);
    const base = PAD_TOP + plotH;
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z`;

    // One cell per point while they fit; on a long range one per bucket of points, coloured by its last fill
    // (else its last point), so the strip stays a strip.
    const per = step >= CELL_W + 2 ? 1 : Math.ceil((CELL_W + 2) / step);
    const groups: BlockEvent[][] = [];
    for (const e of series) {
      const g = groups[groups.length - 1];
      const id = Math.floor(e.block / (per * span));
      if (g && Math.floor(g[0].block / (per * span)) === id) g.push(e);
      else groups.push([e]);
    }
    const cells = groups.map((g, i) => {
      const e = g[g.length - 1];
      const filled = [...g].reverse().find((x) => x.fill);
      return {
        key: e.block,
        x: fx(e.block) - CELL_W / 2,
        fill: cellFill(filled ?? e),
        opacity: i === groups.length - 1 ? 1 : e.quote && e.quote.status === "sent" ? 0.6 : 0.82,
      };
    });

    const beads = series
      .filter((e) => e.fill)
      .map((e) => ({
        key: e.block,
        x: fx(e.block),
        y: fy(e.mid),
        fill: e.fill!.side === "buy" ? "var(--buy)" : "var(--sell)",
      }));

    const ticks = [0.25, 0.5, 0.75].map((f) => ({
      y: PAD_TOP + plotH * f,
      label: venue.fmtMid(lo + (1 - f) * range),
    }));

    const byBlock = new Map(series.map((e) => [e.block, e]));

    // Clock time under the strip (OKX only: the Kuru demo stays as it was). Blocks are seconds, so a label sits
    // on each round time, spaced to fit the range, and slides with the data instead of hopping.
    const every = LABEL_EVERY.find((s) => s * pxPerBlock >= 90) ?? 3600;
    const times: { key: number; x: number; label: string }[] = [];
    if (zoomable) {
      for (let b = Math.ceil(series[0].block / every) * every; b <= last.block; b += every) {
        const d = new Date(b * 1000);
        times.push({ key: b, x: fx(b), label: d.toLocaleTimeString("en-GB", every >= 60 ? { hour: "2-digit", minute: "2-digit", hour12: false } : { hour12: false }) });
      }
    }

    // RSI from candles of `candle` seconds (closes: the last mid in each), warmed up on the history left of the view.
    let rsi: { path: string; top: number; h: number; y: (v: number) => number; last: number | null; candle: number } | null = null;
    if (showRsi) {
      const candle = Math.max(span, RSI_CANDLES.find((c) => c >= windowSec / 60) ?? 60);
      const firstShown = last.block - windowSec - 2 * span;
      const all = events.length && latest && latest.block > events[events.length - 1].block ? [...events, latest] : events;
      const closes: { b: number; c: number }[] = [];
      for (const e of all) {
        if (e.block < firstShown - (RSI_N + 2) * candle) continue;
        const id = Math.floor(e.block / candle);
        const prev = closes[closes.length - 1];
        if (prev && Math.floor(prev.b / candle) === id) { prev.b = e.block; prev.c = e.mid; } else closes.push({ b: e.block, c: e.mid });
      }
      const vals = rsiOf(closes.map((x) => x.c));
      const top = h - PAD_BOTTOM - rsiH;
      const ry = (v: number) => top + (1 - v / 100) * rsiH;
      const pts = closes.map((x, i) => ({ x: fx(x.b), v: vals[i] })).filter((p): p is { x: number; v: number } => p.v !== null && p.x >= fx(firstShown) - step);
      rsi = { path: pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${ry(p.v).toFixed(1)}`).join(" "), top, h: rsiH, y: ry, last: vals[vals.length - 1] ?? null, candle };
    }

    return {
      rsi,
      line,
      area,
      cells,
      beads,
      hot: beads.length ? beads[beads.length - 1] : null,
      hotCell: cells[cells.length - 1],
      ticks,
      byBlock,
      times,
      fx,
      fy,
      last,
      base,
      shift: w - ANCHOR_GAP - fx(last.block),
      endY: Math.min(Math.max(fy(last.mid), PAD_TOP), base),
      plotTop: PAD_TOP,
      plotH,
      step,
    };
  }, [events, latest, w, h, venue, zoomable, windowSec, yzoom, rsiOn]);

  const hv = useMemo(() => {
    if (!model || hover === null) return null;
    const e = model.byBlock.get(hover);
    if (!e) return null;
    const x = model.fx(e.block);
    const flip = x + model.shift > w - 168;
    const ty = Math.min(Math.max(model.fy(e.mid) - 92, PAD_TOP - 46), model.base - 82);
    const side = e.fill ? t(e.fill.side === "buy" ? "word.buy" : "word.sell") : null;
    const q = e.quote;
    const quoteText = q ? `${t(q.side === "buy" ? "word.bid" : "word.ask")} ${fmtPrice(q.price, venue.priceDecimals)}` : t("chart.noQuote");
    return {
      x,
      y: model.fy(e.mid),
      tx: flip ? x - 146 : x + 14,
      ty,
      block: `#${e.block}`,
      price: venue.fmtMid(e.mid),
      trade: side ? `${t("word.fill")} ${side} ${venue.name === "kuru" ? fmtMon(e.fill!.size, 0) : fmtMon(e.fill!.size, venue.sizeDecimals, venue.base)}` : quoteText,
      tint: e.fill ? (e.fill.side === "buy" ? "var(--buy-ink)" : "var(--sell-ink)") : q ? (q.side === "buy" ? "var(--buy-ink)" : "var(--sell-ink)") : "var(--muted)",
      lat: e.decision && !e.decision.late ? `${Math.round(e.decision.latencyMs)} ms` : t("chart.late"),
    };
  }, [model, hover, w, venue, t]);

  const shown = latest ?? events[events.length - 1] ?? null;
  const d = shown?.decision ?? null;
  const late = d?.late === true;
  const act = late ? "late" : (d?.action ?? "hold");
  // The spike strategy emits a hold with no model call (latency 0) on every quiet tick: that is waiting, not a decision.
  const waiting = act === "hold" && !!d && d.latencyMs === 0;
  const word =
    act === "buy" ? t("chart.buying") : act === "sell" ? t("chart.selling") : act === "late" ? t("chart.missed", { clock: clockWord }) : waiting ? t("chart.waiting") : venue.name === "kuru" ? t("chart.holding") : t("chart.skipping");
  const wordColor =
    act === "buy"
      ? "var(--buy-ink)"
      : act === "sell"
        ? "var(--sell-ink)"
        : act === "late"
          ? "var(--late-ink)"
          : "var(--ink)";
  const wordRef = useRef<{ act: string; block: number }>({ act, block: shown?.block ?? 0 });
  if (wordRef.current.act !== act) wordRef.current = { act, block: shown?.block ?? 0 };
  const conf = d ? Math.max(d.probabilities.buy, d.probabilities.sell, d.probabilities.hold) : 0;
  const pos = shown?.position;
  const stance =
    !pos || pos.side === "flat"
      ? t("chart.flat")
      : `${t(pos.side === "long" ? "chart.long" : "chart.short")} ${fmtMon(pos.size, Number.isInteger(pos.size) ? 0 : Math.max(3, venue.sizeDecimals), venue.base)}`;
  const pnlMon = shown?.totals?.pnlMon ?? 0;
  const pnlPct = shown?.totals?.pnlPct ?? 0;
  // Kuru shows P&L in MON, as it always has. Elsewhere one base unit can be worth a lot (BTC), so show
  // it in the quote currency instead.
  const pnlQuote = shown?.totals?.pnlUsd ?? 0;
  const pnlText = venue.name === "kuru" ? fmtSignedMon(pnlMon, 3) : `${fmtSigned(pnlQuote, 4)} ${venue.quoteCcy}`;
  const pnlSign = venue.name === "kuru" ? pnlMon : pnlQuote;

  return (
    <div className={zoomable ? `${styles.wrap} ${styles.wrapControls}` : styles.wrap}>
      <div
        ref={panelRef}
        className={styles.panel}
        onPointerMove={(ev) => {
          if (ev.pointerType !== "mouse" || !model || originRef.current === null) return;
          const r = ev.currentTarget.getBoundingClientRect();
          const x = ev.clientX - r.left - model.shift;
          let best: number | null = null, dist = Math.max(model.step, 4);
          for (const b of model.byBlock.keys()) { const d = Math.abs(model.fx(b) - x); if (d <= dist) { dist = d; best = b; } }
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {!model || !shown ? (
          <div className={styles.empty}>waiting for blocks…</div>
        ) : (
          <>
            <svg className={styles.svg} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
              <defs>
                <linearGradient id={`g${gid}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgba(10,10,10,0.07)" />
                  <stop offset="100%" stopColor="rgba(10,10,10,0)" />
                </linearGradient>
              </defs>

              {model.ticks.map((t) => (
                <line key={t.y} className={styles.grid} x1="0" x2={w} y1={t.y} y2={t.y} />
              ))}

              {model.rsi ? (
                <g>
                  <rect className={styles.rsiZone} x={0} width={w} y={model.rsi.y(100)} height={model.rsi.y(70) - model.rsi.y(100)} />
                  <rect className={styles.rsiZone} x={0} width={w} y={model.rsi.y(30)} height={model.rsi.y(0) - model.rsi.y(30)} />
                  {[70, 30].map((v) => (
                    <g key={v}>
                      <line className={styles.rsiGuide} x1={0} x2={w - TAG_W - 8} y1={model.rsi!.y(v)} y2={model.rsi!.y(v)} />
                      <text className={styles.tick} x={w - 8} y={model.rsi!.y(v) + 3} textAnchor="end">{v}</text>
                    </g>
                  ))}
                  <text className={styles.rsiLabel} x={14} y={model.rsi.top - 3}>
                    {t("rsi.label", { n: RSI_N, candle: model.rsi.candle >= 60 ? t("range.m", { n: model.rsi.candle / 60 }) : t("rsi.sec", { n: model.rsi.candle }) })}
                    {model.rsi.last !== null ? ` ${model.rsi.last.toFixed(1)}` : ` ${t("rsi.warming")}`}
                  </text>
                </g>
              ) : null}

              <g className={styles.slide} style={{ transform: `translateX(${model.shift.toFixed(1)}px)` }}>
                {/* clipped to the plot so a zoomed-in line does not run into the overlays */}
                <clipPath id={`c${gid}`}>
                  <rect x={-model.shift} y={model.plotTop - 14} width={w} height={model.plotH + 28} />
                </clipPath>
                <g clipPath={`url(#c${gid})`}>
                <path d={model.area} fill={`url(#g${gid})`} />
                <path className={styles.line} d={model.line} />
                </g>
                {model.rsi ? <path className={styles.rsiLine} d={model.rsi.path} /> : null}
                {model.beads.map((b) => (
                  <circle
                    key={b.key}
                    className={b.key === model.hot?.key ? styles.beadPop : undefined}
                    cx={b.x}
                    cy={b.y}
                    r="3"
                    fill={b.fill}
                    opacity="0.7"
                  />
                ))}
                {model.hot ? (
                  <g key={model.hot.key}>
                    <line
                      className={styles.riser}
                      x1={model.hot.x}
                      x2={model.hot.x}
                      y1={h - 40}
                      y2={model.hot.y}
                      stroke={model.hot.fill}
                    />
                    <circle
                      className={styles.ripple}
                      cx={model.hot.x}
                      cy={model.hot.y}
                      r="3"
                      fill="none"
                      stroke={model.hot.fill}
                      strokeWidth="2"
                    />
                  </g>
                ) : null}
                <rect
                  key={`glow${model.hotCell.key}`}
                  className={styles.cellGlow}
                  x={model.hotCell.x}
                  y={h - 40}
                  width={CELL_W}
                  height={CELL_H}
                  rx="3"
                  fill={model.hotCell.fill}
                />
                {model.times.map((tm) => (
                  <text key={`t${tm.key}`} className={styles.tick} x={tm.x} y={h - 6} textAnchor="middle">
                    {tm.label}
                  </text>
                ))}
                {model.cells.map((c, i) => (
                  <rect
                    key={c.key}
                    className={i === model.cells.length - 1 ? styles.cellPop : undefined}
                    x={c.x}
                    y={h - 40}
                    width={CELL_W}
                    height={CELL_H}
                    rx="3"
                    fill={c.fill}
                    opacity={c.opacity}
                  />
                ))}
                {hv ? (
                  <g>
                    <line className={styles.cross} x1={hv.x} x2={hv.x} y1={PAD_TOP - 12} y2={model.base + 10} />
                    <circle className={styles.crossDot} cx={hv.x} cy={hv.y} r="4.5" />
                    <g transform={`translate(${hv.tx.toFixed(1)},${hv.ty.toFixed(1)})`}>
                      <rect className={styles.tip} width="132" height="78" rx="10" />
                      <text className={styles.tipBlock} x="12" y="21">{hv.block}</text>
                      <text className={styles.tipPrice} x="12" y="41">{hv.price}</text>
                      <text className={styles.tipSide} x="12" y="58" fill={hv.tint}>{hv.trade}</text>
                      <text className={styles.tipMeta} x="12" y="71">{hv.lat}</text>
                    </g>
                  </g>
                ) : null}
              </g>

              {model.ticks.map((t) => (
                <text key={`l${t.y}`} className={styles.tick} x={w - 8} y={t.y - 5} textAnchor="end">
                  {t.label}
                </text>
              ))}

              <g className={styles.tag} style={{ transform: `translateY(${model.endY.toFixed(1)}px)` }}>
                <line className={styles.guide} x1={w - ANCHOR_GAP + 8} x2={w - TAG_W - 6} y1="0" y2="0" />
                <circle className={styles.halo} cx={w - ANCHOR_GAP} cy="0" r="4" fill="var(--ink)" />
                <circle cx={w - ANCHOR_GAP} cy="0" r="4" fill="var(--ink)" />
                <rect x={w - TAG_W - 4} y="-10" width={TAG_W} height="20" rx="999" fill="var(--ink)" />
                <text className={styles.tagText} x={w - 4 - TAG_W / 2} y="4" textAnchor="middle">
                  {venue.fmtMid(model.last.mid)}
                </text>
              </g>
            </svg>

            <div className={styles.fade} />

            <div className={styles.tl}>
              <div className={styles.price} key={shown.mid}>
                {venue.fmtMid(shown.mid)}
              </div>
              <div className={styles.sub}>
                <span>{venue.pair}</span>
                <span>{venue.label}</span>
                <span>{stance}</span>
                <span style={{ color: pnlSign >= 0 ? "var(--pnl-pos)" : "var(--pnl-neg)" }}>
                  {t("chart.pnl")} {pnlText} ({fmtSigned(pnlPct, 2)}%)
                </span>
              </div>
            </div>

            <div className={styles.tr}>
              <div
                className={`${styles.word} ${styles.wordPop}`}
                key={`${wordRef.current.block}-${act}`}
                style={{ color: wordColor }}
              >
                {word}
              </div>
              <div className={styles.sub}>
                {waiting ? null : (
                  <>
                    <span>{!d || late ? t("chart.late") : `${Math.round(d.latencyMs)} ms`}</span>
                    <span>{t("chart.conf")} {fmtConf(conf)}</span>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      {zoomable ? (
        <div className={styles.zoom} style={model?.rsi ? { bottom: 80 + model.rsi.h + 12 } : undefined} onPointerMove={(e) => e.stopPropagation()}>
          {RANGES.map((r) => (
            <button key={r} type="button" className={r === windowSec ? styles.rangeOn : styles.range} aria-pressed={r === windowSec} onClick={() => pickRange(r)}>
              {r >= 3600 ? t("range.h", { n: r / 3600 }) : t("range.m", { n: r / 60 })}
            </button>
          ))}
          <button type="button" className={`${rsiOn ? styles.rangeOn : styles.range} ${styles.zoomGapBtn}`} aria-pressed={rsiOn} onClick={toggleRsi}>RSI</button>
          <span className={styles.zoomGap}>{t("zoom.y")}</span>
          <button type="button" onClick={() => zoomY(1 / 1.25)} aria-label="zoom out price">-</button>
          <button type="button" onClick={() => zoomY(1.25)} aria-label="zoom in price">+</button>
          {yz !== 1 ? <button type="button" className={styles.zoomReset} onClick={() => zoomY(null)}>{t("zoom.reset")}</button> : null}
        </div>
      ) : null}
    </div>
  );
}
