"use client";

import { useState } from "react";
import type { SpikeSnapshot } from "@/lib/types";
import { useVenue } from "@/lib/venue";
import { span, useLang } from "@/lib/i18n";
import styles from "./Spike.module.css";

const sign = (n: number, d: number) => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(d)}`;

/** One bar: the move vs a minute (or three) ago, scaled so the trigger sits at the track's end. */
function Gauge({ label, pct, threshold }: { label: string; pct: number | null; threshold: number }) {
  const v = pct ?? 0;
  const frac = Math.min(1, Math.abs(v) / threshold) / 2; // half the track = the trigger
  const colour = v >= 0 ? "var(--up-bar)" : "var(--down-bar)";
  const style = v >= 0 ? { left: "50%", width: `${frac * 100}%`, background: colour } : { left: `${50 - frac * 100}%`, width: `${frac * 100}%`, background: colour };
  return (
    <div className={styles.gaugeRow}>
      <span className={styles.dim}>{label}</span>
      <div className={styles.track}>
        <div className={styles.fill} style={style} />
      </div>
      <span className={`${styles.mono} ${styles.right}`}>{pct === null ? "-" : `${sign(v, 2)}%`}</span>
    </div>
  );
}

/** Jev's open position (entry, take-profit, stop, time left), and how close the market is to the next spike. */
export default function SpikeStatus({ snap, apiUrl }: { snap: SpikeSnapshot | null; apiUrl: string }) {
  const venue = useVenue();
  const { t } = useLang();
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  // POST /spike/reset with the admin token saved in the settings panel: measure the next spike from the price now.
  const reset = async () => {
    let token = "";
    try { token = localStorage.getItem("jev.adminToken") ?? ""; } catch { /* no storage */ }
    if (!token) { setResetMsg(t("spike.resetNoToken")); return; }
    try {
      const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/spike/reset`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      const body = await r.json();
      setResetMsg(r.ok ? t("spike.resetDone", { px: venue.fmtMid(body.reference) }) : r.status === 401 ? t("settings.unauthorized") : t("spike.resetFailed"));
    } catch {
      setResetMsg(t("spike.resetFailed"));
    }
    setTimeout(() => setResetMsg(null), 4000);
  };
  const plan = snap?.plan;
  const jev = snap?.open.find((o) => o.who === "jev") ?? null;
  const px = (n: number) => n.toFixed(venue.priceDecimals);
  return (
    <>
      <section className={styles.section}>
        <div className={styles.label}>
          <span>{t("spike.position")}</span>
          {plan ? (
            <span className={styles.labelNote}>
              {t("spike.exits", { tp: plan.takeProfitRoePct, sl: plan.stopLossRoePct, lev: plan.leverage })}
              {plan.sides && plan.sides !== "both" ? `, ${t(plan.sides === "long" ? "sides.1" : "sides.2")}` : ""}
            </span>
          ) : null}
        </div>
        {jev ? (
          <>
            <div className={styles.posHead}>
              <span className={styles.posWord} style={{ color: jev.side === "buy" ? "var(--buy-ink)" : "var(--sell-ink)" }}>
                {t(jev.side === "buy" ? "spike.long" : "spike.short")} {jev.size ?? plan?.size} {plan?.base}
                {jev.adds ? <span className={styles.labelNote} style={{ fontSize: 12, marginLeft: 8 }}>{t("spike.adds", { n: jev.adds })}</span> : null}
              </span>
              <span className={`${styles.posRoe} ${jev.unrealizedRoePct >= 0 ? styles.pos : styles.neg}`}>
                ROE {sign(jev.unrealizedRoePct, 1)}%{jev.unrealizedUsd !== undefined ? ` (${sign(jev.unrealizedUsd, 3)} USDT)` : ""}
              </span>
            </div>
            <div className={styles.kv}>
              <div><div className={styles.k}>{t("spike.entry")}</div><div className={styles.v}>{px(jev.entry)}</div></div>
              <div><div className={styles.k}>{t("spike.tp")}</div><div className={styles.v}>{px(jev.tp)}</div></div>
              <div><div className={styles.k}>{t("spike.sl")}</div><div className={styles.v}>{px(jev.sl)}</div></div>
              <div>
                <div className={styles.k}>{t("spike.timeLeft")}</div>
                <div className={styles.v}>{plan ? t("spike.min", { n: Math.max(0, Math.round(plan.maxHoldMin - jev.heldMin)) }) : "-"}</div>
              </div>
            </div>
          </>
        ) : (
          <div className={styles.flat}>{t("spike.flat")}</div>
        )}
      </section>
      <section className={styles.section}>
        <div className={styles.label}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {t("spike.distance")}
            <button type="button" className={styles.miniButton} onClick={reset}>{t("spike.reset")}</button>
            {resetMsg ? <span className={styles.labelNote}>{resetMsg}</span> : null}
          </span>
          <span className={styles.labelNote}>
            {snap && snap.gauge.cooldownSec > 0 ? t("spike.cooldown", { n: snap.gauge.cooldownSec }) : snap?.gauge.extreme && plan ? t("spike.extremeTrigger", { kind: t(snap.gauge.extreme.kind === "high" ? "spike.fromHigh" : "spike.fromLow"), px: venue.fmtMid(snap.gauge.extreme.price), a: plan.move1mPct }) : plan ? t("spike.trigger", { a: plan.move1mPct, b: plan.move3mPct, w1: span(t, plan.window1Sec ?? 60), w2: span(t, plan.window2Sec ?? 180) }) : ""}
          </span>
        </div>
        {snap?.gauge.extreme ? (
          // Long or short only: one gauge, the move from the running high or low.
          <Gauge label={t(snap.gauge.extreme.kind === "high" ? "spike.fromHigh" : "spike.fromLow")} pct={snap.gauge.r1Pct} threshold={plan?.move1mPct ?? 0.5} />
        ) : (
          <>
            <Gauge label={span(t, plan?.window1Sec ?? 60)} pct={snap?.gauge.r1Pct ?? null} threshold={plan?.move1mPct ?? 0.5} />
            <Gauge label={span(t, plan?.window2Sec ?? 180)} pct={snap?.gauge.r3Pct ?? null} threshold={plan?.move3mPct ?? 0.8} />
          </>
        )}
      </section>
    </>
  );
}
