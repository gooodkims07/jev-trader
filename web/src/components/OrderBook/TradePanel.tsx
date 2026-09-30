"use client";

import { useEffect, useRef, useState } from "react";
import type { SpikeSnapshot } from "@/lib/types";
import { useLang } from "@/lib/i18n";
import { useVenue } from "@/lib/venue";
import { adminToken, type TradeSide, type TradeState } from "@/lib/useTradeInfo";
import styles from "./TradePanel.module.css";

type Side = TradeSide;
const TAKER = 0.0005;
const MAKER = 0.0002;
const tokenNow = adminToken;

/**
 * Orders by hand on the bot's coin (live OKX): limit or market, amount by hand or as a share of what the balance
 * allows, reduce-only, and a take-profit / stop the bot puts on the position once it fills (else the settings').
 * Two clicks to send. Resting orders below, with cancel.
 */
export default function TradePanel({ apiUrl, snap, pickedPrice, trade }: { apiUrl: string; snap: SpikeSnapshot | null; pickedPrice: { price: number; at: number } | null; trade: TradeState }) {
  const venue = useVenue();
  const { t } = useLang();
  const base = apiUrl.replace(/\/+$/, "");
  const { info, reload: load } = trade;
  const err = trade.err ? (trade.err.includes(".") && !trade.err.includes(" ") ? t(trade.err as "trade.noToken") : trade.err) : null;
  const [type, setType] = useState<"limit" | "market">("limit");
  const [price, setPrice] = useState("");
  const [bbo, setBbo] = useState(false);
  const [amount, setAmount] = useState("");
  const [pct, setPct] = useState(0);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [tpPct, setTpPct] = useState("");
  const [slPct, setSlPct] = useState("");
  const [confirm, setConfirm] = useState<Side | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // A price clicked in the order book fills the limit price, once per click.
  const pickedAt = useRef(0);
  useEffect(() => {
    if (!pickedPrice || pickedPrice.at === pickedAt.current) return;
    pickedAt.current = pickedPrice.at;
    setType("limit"); setBbo(false); setPrice(pickedPrice.price.toFixed(venue.priceDecimals));
  }, [pickedPrice, venue.priceDecimals]);

  // The settings' exits as the starting point for this order's.
  useEffect(() => {
    if (!tpsl || !snap) return;
    if (!tpPct) setTpPct(String(+snap.plan.takeProfitPct.toFixed(2)));
    if (!slPct) setSlPct(String(+snap.plan.stopLossPct.toFixed(2)));
  }, [tpsl, snap, tpPct, slPct]);

  // The confirm step times out.
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(null), 5000);
    return () => clearTimeout(id);
  }, [confirm]);

  if (err && !info) return <div className={styles.panel}><div className={styles.note}>{err}</div></div>;
  if (!info) return <div className={styles.panel}><div className={styles.note}>{t("book.loading")}</div></div>;

  const dec = venue.priceDecimals;
  const mid = (info.bid + info.ask) / 2;
  const limitPx = bbo ? null : Number(price);
  const refFor = (side: Side) => (type === "market" || bbo || !(limitPx! > 0) ? (side === "buy" ? info.ask : info.bid) : limitPx!);
  const lotDown = (x: number) => Math.max(0, Math.floor(x / info.lot + 1e-9) * info.lot);
  // What one order may open: the balance, and the safety cap (a share of equity as margin), whichever is less.
  const capMargin = ((info.equity ?? info.available) * (info.maxMarginPct ?? 100)) / 100;
  const openPx = limitPx && limitPx > 0 && type === "limit" && !bbo ? limitPx : mid;
  const maxOpen = lotDown((Math.min(info.available * 0.98, capMargin) * info.leverage) / openPx);
  const pos = info.position.size;
  const maxBuy = maxOpen + (pos < 0 ? -pos : 0), maxSell = maxOpen + (pos > 0 ? pos : 0);
  const amt = Number(amount);
  const fmtAmt = (x: number) => String(+x.toFixed(6));
  const setByPct = (p: number) => { setPct(p); setAmount(p ? fmtAmt(lotDown((maxOpen * p) / 100)) : ""); };
  const feeRate = type === "market" ? TAKER : MAKER;
  const cost = (side: Side) => (amt > 0 ? (amt * refFor(side)) / info.leverage + amt * refFor(side) * feeRate : null);
  const liq = (side: Side) => {
    if (!(amt > 0) || reduceOnly) return null;
    const p = refFor(side), l = info.leverage;
    return side === "buy" ? (p * (1 - 1 / l)) / (1 - info.mmr) : (p * (1 + 1 / l)) / (1 + info.mmr);
  };
  const tpN = Number(tpPct), slN = Number(slPct);
  const exitsFor = (side: Side) => {
    const p = refFor(side), d = side === "buy" ? 1 : -1;
    return { tp: p * (1 + (d * tpN) / 100), sl: p * (1 - (d * slN) / 100) };
  };
  const stepPrice = (k: number) => {
    const p = Number(price) || mid;
    setBbo(false); setPrice((Math.round(p / info.tick) * info.tick + k * info.tick).toFixed(dec));
  };

  // A reduce-only order only shrinks the position: call it a buy / sell, not a long / short.
  const sideWord = (side: Side, ro: boolean) => t(ro ? (side === "buy" ? "trade.buyRo" : "trade.sellRo") : side === "buy" ? "trade.long" : "trade.short");

  const send = async (side: Side) => {
    // Something missing: say what (the buttons stay clickable, a greyed-out one looks broken).
    if (missing) { setConfirm(null); setMsg({ ok: false, text: t(missing) }); return; }
    if (overCap(side)) { setConfirm(null); setMsg({ ok: false, text: t("trade.overCap", { pct: info.maxMarginPct, cap: capMargin.toFixed(2), n: fmtAmt(side === "buy" ? maxBuy : maxSell) }) }); return; }
    if (confirm !== side) { setConfirm(side); setMsg(null); return; } // first click: arm; the second sends
    setConfirm(null); setBusy(true); setMsg(null);
    const body: Record<string, unknown> = { side, type, size: amt, reduceOnly };
    if (type === "limit") { if (bbo) body.bbo = true; else body.price = Number(price); }
    if (tpsl && !reduceOnly) { body.tpPct = tpN; body.slPct = slN; }
    try {
      const r = await fetch(`${base}/trade/order`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenNow()}` }, body: JSON.stringify(body) });
      const res = await r.json();
      if (!r.ok) setMsg({ ok: false, text: res.error ?? t("trade.failed") });
      else if (type === "market") setMsg({ ok: true, text: t("trade.filled", { side: sideWord(side, reduceOnly), n: fmtAmt(res.filled), px: res.avgPx ? res.avgPx.toFixed(dec) : "-" }) });
      else setMsg({ ok: true, text: t("trade.placed", { side: sideWord(side, reduceOnly), n: fmtAmt(amt), px: res.price?.toFixed(dec) ?? "-" }) });
      if (r.ok) { setAmount(""); setPct(0); }
      load();
    } catch { setMsg({ ok: false, text: t("trade.failed") }); }
    setBusy(false);
  };

  const cancel = async (ordId: string) => {
    try {
      const r = await fetch(`${base}/trade/cancel`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenNow()}` }, body: JSON.stringify({ ordId }) });
      const res = await r.json();
      setMsg(r.ok ? { ok: true, text: t("trade.canceled") } : { ok: false, text: res.error ?? t("trade.failed") });
      load();
    } catch { setMsg({ ok: false, text: t("trade.failed") }); }
  };

  const pos0 = info.position.size;
  const openingFor = (side: Side) => Math.max(0, amt - ((side === "buy" ? pos0 < 0 : pos0 > 0) ? Math.abs(pos0) : 0));
  const overCap = (side: Side) => !reduceOnly && (openingFor(side) * refFor(side)) / info.leverage > capMargin + 1e-9;
  const missing = !(amt > 0) ? "trade.needAmount" : type === "limit" && !bbo && !(Number(price) > 0) ? "trade.needPrice" : tpsl && !reduceOnly && !(tpN > 0 && slN > 0) ? "trade.needExits" : null;
  const kind = t(type === "market" ? "trade.market" : "trade.limit");
  const button = (side: Side) => (
    <button type="button" className={side === "buy" ? styles.buy : styles.sell} disabled={busy} onClick={() => send(side)}>
      {confirm === side ? t("trade.confirm", { side: sideWord(side, reduceOnly), n: fmtAmt(amt), base: venue.base, kind }) : t(reduceOnly ? (side === "buy" ? "trade.buyRo" : "trade.sellRo") : side === "buy" ? "trade.buyLong" : "trade.sellShort")}
    </button>
  );
  const side2 = (side: Side) => {
    const c = cost(side), l = liq(side);
    return (
      <div className={side === "sell" ? styles.metaRight : styles.meta}>
        <div>{t("trade.cost")} <b>{c !== null ? `${c.toFixed(2)} USDT` : "-"}</b></div>
        {info.limits ? <div>{t(side === "buy" ? "trade.maxPrice" : "trade.minPrice")} <b>{(side === "buy" ? info.limits.buy : info.limits.sell).toFixed(dec)}</b></div> : null}
        <div>{t("trade.liq")} <b>{l !== null ? l.toFixed(dec) : "-"}</b></div>
      </div>
    );
  };

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {(["limit", "market"] as const).map((k) => (
          <button key={k} type="button" className={k === type ? styles.tabOn : undefined} onClick={() => { setType(k); setConfirm(null); }}>{t(k === "market" ? "trade.market" : "trade.limit")}</button>
        ))}
      </div>

      {type === "limit" ? (
        <>
          <div className={styles.label}>{t("trade.price", { ccy: venue.quoteCcy })}</div>
          <div className={styles.priceRow}>
            <input className={styles.input} inputMode="decimal" value={bbo ? "BBO" : price} placeholder={mid.toFixed(dec)} onChange={(e) => { setBbo(false); setPrice(e.target.value); }} aria-label={t("trade.price", { ccy: venue.quoteCcy })} />
            <span className={styles.steps}>
              <button type="button" onClick={() => stepPrice(1)} aria-label="price up">+</button>
              <button type="button" onClick={() => stepPrice(-1)} aria-label="price down">-</button>
            </span>
            <button type="button" className={bbo ? styles.bboOn : styles.bbo} onClick={() => setBbo((x) => !x)} title={t("trade.bboHelp")}>BBO</button>
          </div>
        </>
      ) : (
        <div className={styles.note}>{t("trade.marketNote")}</div>
      )}

      <div className={styles.label}>{t("trade.amount", { base: venue.base })}</div>
      <input className={styles.input} inputMode="decimal" value={amount} placeholder={t("trade.minLot", { n: fmtAmt(info.min), lot: fmtAmt(info.lot) })} onChange={(e) => { setAmount(e.target.value); setPct(0); }} aria-label={t("trade.amount", { base: venue.base })} />
      <div className={styles.pcts}>
        {[0, 25, 50, 75, 100].map((p) => (
          <button key={p} type="button" className={p === pct && (p > 0 || !amount) ? styles.pctOn : undefined} onClick={() => setByPct(p)}>{p}%</button>
        ))}
      </div>
      <div className={styles.kv}><span>{t("trade.available")}</span><b>{info.available.toFixed(2)} USDT</b></div>
      <div className={styles.kv}><span>{t("trade.cap")}</span><b>{t("trade.capIs", { pct: info.maxMarginPct, cap: capMargin.toFixed(2) })}</b></div>
      <div className={styles.kv}><span>{t("trade.maxBuy")} <b>{fmtAmt(maxBuy)}</b></span><span>{t("trade.maxSell")} <b>{fmtAmt(maxSell)}</b></span></div>

      <label className={styles.check}><input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> {t("trade.reduceOnly")}</label>
      <label className={styles.check}><input type="checkbox" checked={tpsl} disabled={reduceOnly} onChange={(e) => setTpsl(e.target.checked)} /> {t("trade.tpsl")}</label>
      {tpsl && !reduceOnly ? (
        <div className={styles.tpsl}>
          <label>{t("trade.tpPct")}<input className={styles.inputSm} inputMode="decimal" value={tpPct} onChange={(e) => setTpPct(e.target.value)} />%</label>
          <label>{t("trade.slPct")}<input className={styles.inputSm} inputMode="decimal" value={slPct} onChange={(e) => setSlPct(e.target.value)} />%</label>
          {tpN > 0 && slN > 0 ? (
            <div className={styles.note}>
              <div>{t("trade.exitsLong", { tp: exitsFor("buy").tp.toFixed(dec), sl: exitsFor("buy").sl.toFixed(dec) })}</div>
              <div>{t("trade.exitsShort", { tp: exitsFor("sell").tp.toFixed(dec), sl: exitsFor("sell").sl.toFixed(dec) })}</div>
            </div>
          ) : null}
        </div>
      ) : !reduceOnly && snap ? (
        <div className={styles.note}>{t("trade.defaultExits", { tp: +snap.plan.takeProfitPct.toFixed(2), sl: +snap.plan.stopLossPct.toFixed(2) })}</div>
      ) : null}

      <div className={styles.buttons}>{button("buy")}{button("sell")}</div>
      {confirm ? <div className={styles.confirmHint}>{t("trade.confirmHint")}</div> : null}
      {busy ? <div className={styles.note}>{t("trade.sending")}</div> : null}
      {msg ? <div className={msg.ok ? styles.ok : styles.bad}>{msg.text}</div> : null}

      <div className={styles.metas}>{side2("buy")}{side2("sell")}</div>

      <div className={styles.section}>
        <div className={styles.kv}><span>{t("trade.mode")}</span><b>{t(info.marginMode === "isolated" ? "trade.isolated" : "trade.cross")} {t("lev.x", { n: info.leverage })}</b></div>
        <div className={styles.kv}><span>{t("trade.position")}</span><b>{pos ? t("trade.positionIs", { side: t(pos > 0 ? "trade.long" : "trade.short"), n: fmtAmt(Math.abs(pos)), px: info.position.avgPx.toFixed(dec) }) : t("trade.flat")}</b></div>
      </div>

      <div className={styles.section}>
        <div className={styles.label}>{t("trade.openOrders", { n: info.orders.length })}</div>
        {info.orders.length === 0 ? <div className={styles.note}>{t("trade.noOrders")}</div> : info.orders.map((o) => (
          <div key={o.ordId} className={styles.order}>
            <span className={o.side === "buy" ? styles.buyInk : styles.sellInk}>{sideWord(o.side, o.reduceOnly)}</span>
            <span>{o.price ? o.price.toFixed(dec) : t("trade.market")}</span>
            <span>{fmtAmt(o.filled)}/{fmtAmt(o.size)}</span>
            {o.reduceOnly ? <span className={styles.tag}>{t("trade.ro")}</span> : null}
            {!o.manual ? <span className={styles.tag}>{t("trade.bot")}</span> : null}
            <button type="button" onClick={() => cancel(o.ordId)}>{t("trade.cancel")}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
