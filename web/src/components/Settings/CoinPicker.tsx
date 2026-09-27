"use client";

import { useEffect, useMemo, useState } from "react";
import { useLang } from "@/lib/i18n";
import styles from "./Settings.module.css";

interface Choice { instId: string; base: string; last: number; volUsd24h: number; lot: number; min: number; tickSz: string }
interface View { current: string; tradeSize: number; maxPosition: number; strategy: "mm" | "spike"; editable: boolean; supervised: boolean; blocker: string | null; choices: Choice[] }

const roundTo = (x: number, step: number) => Number((Math.round(x / step) * step).toFixed(10));

/**
 * GET /instrument lists the coins; switching POSTs the coin and a size on its lot, and the server restarts on it.
 * Picking a coin suggests a size worth the same USDT as now; the viewer can change it.
 */
export default function CoinPicker({ base, token, onRestart }: { base: string; token: string; onRestart: () => void }) {
  const { t } = useLang();
  const [view, setView] = useState<View | null>(null);
  const [inst, setInst] = useState("");
  const [size, setSize] = useState("");
  const [cap, setCap] = useState("");
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${base}/instrument`, { cache: "no-store" }).then((r) => r.json()).then((v: View) => {
      if (!v?.choices) return;
      setView(v); setInst(v.current); setSize(String(v.tradeSize)); setCap(String(v.maxPosition));
    }).catch(() => {});
  }, [base]);

  const cur = view?.choices.find((c) => c.instId === view.current);
  const pick = useMemo(() => view?.choices.find((c) => c.instId === inst), [view, inst]);

  // A new coin: keep the order (and the cap) worth about the same USDT, on the new coin's step, at least its minimum.
  const choose = (id: string) => {
    setInst(id); setMsg(null);
    const c = view?.choices.find((x) => x.instId === id);
    if (!view || !c) return;
    if (id === view.current) { setSize(String(view.tradeSize)); setCap(String(view.maxPosition)); return; }
    const usd = cur ? view.tradeSize * cur.last : 10;
    const s = Math.max(c.min, roundTo(usd / c.last, c.lot));
    setSize(String(s));
    setCap(String(Math.max(s, roundTo((view.maxPosition / view.tradeSize) * s, c.lot))));
  };

  const apply = async () => {
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { instId: inst, tradeSize: Number(size) };
      if (view?.strategy === "mm") body.maxPosition = Number(cap);
      const r = await fetch(`${base}/instrument`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const out = await r.json();
      if (r.status === 202) { setMsg({ kind: "good", text: t("coin.restarting", { inst }) }); setTimeout(onRestart, 2500); }
      else if (r.status === 401) setMsg({ kind: "bad", text: t("settings.unauthorized") });
      else setMsg({ kind: "bad", text: `${t("settings.error")}: ${out?.errors ? Object.values(out.errors).join(", ") : out?.error ?? r.status}` });
    } catch (e) {
      setMsg({ kind: "bad", text: `${t("settings.error")}: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;
  // Only a new coin goes through here (with its sizes); sizes for the current coin are the regular fields below.
  const changed = inst !== view.current;
  const usd = pick && Number(size) ? (Number(size) * pick.last).toFixed(2) : "-";
  return (
    <div className={styles.group}>
      <div className={styles.groupLabel}>{t("settings.group.coin")}</div>
      <div className={styles.field}>
        <label htmlFor="coin">{t("coin.pick")}</label>
        <select id="coin" className={`${styles.input} ${inst !== view.current ? styles.changed : ""}`} style={{ gridColumn: "2 / 4" }} value={inst} disabled={!view.editable || busy} onChange={(e) => choose(e.target.value)}>
          {view.choices.map((c) => (
            <option key={c.instId} value={c.instId}>
              {c.base} {c.last} ({t("coin.vol", { vol: Math.round(c.volUsd24h / 1e6) })})
            </option>
          ))}
        </select>
      </div>
      {inst !== view.current ? (<>
      <div className={styles.field}>
        <label htmlFor="coinSize">{t("coin.size")}</label>
        <input id="coinSize" className={styles.input} type="number" inputMode="decimal" min={pick?.min} step={pick?.lot} value={size} disabled={!view.editable || busy} onChange={(e) => setSize(e.target.value)} />
        <span className={styles.unit}>{pick?.base}</span>
      </div>
      {view.strategy === "mm" ? (
        <div className={styles.field}>
          <label htmlFor="coinCap">{t("coin.cap")}</label>
          <input id="coinCap" className={styles.input} type="number" inputMode="decimal" min={pick?.min} step={pick?.lot} value={cap} disabled={!view.editable || busy} onChange={(e) => setCap(e.target.value)} />
          <span className={styles.unit}>{pick?.base}</span>
        </div>
      ) : null}
      {pick ? <div className={styles.note}>{t("coin.hint", { lot: pick.lot, min: pick.min, base: pick.base, usd })}</div> : null}
      </>) : null}
      <div className={styles.note}>{t("coin.dryRunNote")}</div>
      {!view.supervised ? <div className={`${styles.notice} ${styles.bad}`}>{t("coin.notSupervised")}</div> : null}
      {view.blocker ? <div className={`${styles.notice} ${styles.bad}`}>{t("coin.blocked", { why: view.blocker })}</div> : null}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
        <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!view.editable || !view.supervised || !!view.blocker || busy || !changed || !token} onClick={apply}>
          {t("coin.apply")}
        </button>
      </div>
      {msg ? <div className={`${styles.notice} ${msg.kind === "good" ? styles.good : styles.bad}`}>{msg.text}</div> : null}
    </div>
  );
}
