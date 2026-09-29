"use client";

import { useEffect, useState } from "react";
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

type Jev = SpikeSnapshot["open"][number];

/**
 * Where the price stands between the stop and the take-profit: the stop always on the left, the take-profit on
 * the right (for a short too), a tick at the entry, and a dot at the price now.
 */
function ExitBar({ jev, px, t }: { jev: Jev; px: (n: number) => string; t: ReturnType<typeof useLang>["t"] }) {
  const dir = jev.side === "buy" ? 1 : -1;
  const now = jev.entry * (1 + (dir * jev.unrealizedPct) / 100);
  const at = (p: number) => Math.min(1, Math.max(0, (dir * (p - jev.sl)) / (dir * (jev.tp - jev.sl)))) * 100;
  const win = jev.unrealizedPct >= 0;
  return (
    <div className={styles.exitBar}>
      <div className={styles.exitTrack}>
        <div className={styles.exitLoss} style={{ width: `${at(jev.entry)}%` }} />
        <div className={styles.exitGain} style={{ left: `${at(jev.entry)}%` }} />
        <div className={styles.exitEntry} style={{ left: `${at(jev.entry)}%` }} />
        <div className={styles.exitNow} style={{ left: `${at(now)}%`, background: win ? "var(--pnl-pos)" : "var(--pnl-neg)" }} title={`${t("bar.now")} ${px(now)}`} />
      </div>
      <div className={styles.exitLabels}>
        <span className={styles.neg}>{t("spike.sl")} {px(jev.sl)}</span>
        <span>{t("spike.entry")} {px(jev.entry)}</span>
        <span className={styles.pos}>{t("spike.tp")} {px(jev.tp)}</span>
      </div>
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
  // Live only: trade or observe (no new orders), POST /settings { "spike.observe": 0 | 1 } with the admin token.
  const [modeMsg, setModeMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const setObserve = async (on: boolean) => {
    let token = "";
    try { token = localStorage.getItem("jev.adminToken") ?? ""; } catch { /* no storage */ }
    if (!token) { setModeMsg(t("spike.resetNoToken")); setTimeout(() => setModeMsg(null), 4000); return; }
    setPending(on);
    try {
      const r = await fetch(`${apiUrl.replace(/\/+$/, "")}/settings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ "spike.observe": on ? 1 : 0 }) });
      if (!r.ok) { setPending(null); setModeMsg(r.status === 401 ? t("settings.unauthorized") : t("mode.failed")); setTimeout(() => setModeMsg(null), 4000); }
    } catch {
      setPending(null); setModeMsg(t("mode.failed")); setTimeout(() => setModeMsg(null), 4000);
    }
  };
  const serverObserve = !!snap?.plan.observe;
  useEffect(() => { if (pending !== null && pending === serverObserve) setPending(null); }, [pending, serverObserve]);
  const observing = pending ?? serverObserve;
  const plan = snap?.plan;
  const jev = snap?.open.find((o) => o.who === "jev") ?? null;
  const px = (n: number) => n.toFixed(venue.priceDecimals);
  return (
    <>
      <section className={styles.section}>
        <div className={styles.label}>
          <span>{t("spike.position")}</span>
          {plan?.live ? (
            <span className={styles.mode} role="group" aria-label={t("mode.label")}>
              {modeMsg ? <span className={styles.labelNote}>{modeMsg}</span> : null}
              <button type="button" className={!observing ? styles.modeLive : undefined} aria-pressed={!observing} disabled={pending !== null} onClick={() => observing && setObserve(false)}>{t("mode.live")}</button>
              <button type="button" className={observing ? styles.modeObserve : undefined} aria-pressed={observing} disabled={pending !== null} onClick={() => !observing && setObserve(true)}>{t("mode.observe")}</button>
            </span>
          ) : null}
        </div>
        {plan?.live && observing ? <div className={styles.observeNote}>{t(jev ? "mode.observeNoteOpen" : "mode.observeNote")}</div> : null}
        {plan ? (
          // The plan at a glance: exits (ROE, with the price move they mean), leverage, sides, hold limit.
          <div className={styles.chips}>
            <span className={`${styles.chip} ${styles.chipTp}`}>
              {t("chip.tp", { roe: plan.takeProfitRoePct })}
              <small>{t("chip.price", { sign: "+", pct: +plan.takeProfitPct.toFixed(2) })}</small>
            </span>
            <span className={`${styles.chip} ${styles.chipSl}`}>
              {t("chip.sl", { roe: plan.stopLossRoePct })}
              <small>{t("chip.price", { sign: "-", pct: +plan.stopLossPct.toFixed(2) })}</small>
            </span>
            <span className={styles.chip}>{t("chip.lev", { n: plan.leverage })}</span>
            <span className={`${styles.chip} ${plan.sides === "long" ? styles.chipLong : plan.sides === "short" ? styles.chipShort : ""}`}>
              {t(plan.sides === "long" ? "sides.1" : plan.sides === "short" ? "sides.2" : "sides.0")}
            </span>
            <span className={styles.chip}>{t("chip.hold", { n: plan.maxHoldMin })}</span>
          </div>
        ) : null}
        {jev ? (
          <>
            <div className={styles.posHead}>
              <span className={styles.posWord} style={{ color: jev.side === "buy" ? "var(--buy-ink)" : "var(--sell-ink)" }}>
                {t(jev.side === "buy" ? "spike.long" : "spike.short")} {jev.size ?? plan?.size} {plan?.base}
                {jev.adds ? <span className={styles.labelNote} style={{ fontSize: 12, marginLeft: 8 }}>{t("spike.adds", { n: jev.adds })}</span> : null}
                {jev.manual ? <span className={styles.labelNote} style={{ fontSize: 12, marginLeft: 8, color: "var(--muted)" }}>{t("spike.manualTag")}</span> : null}
              </span>
              <span className={`${styles.posRoe} ${jev.unrealizedRoePct >= 0 ? styles.pos : styles.neg}`}>
                ROE {sign(jev.unrealizedRoePct, 1)}%{jev.unrealizedUsd !== undefined ? ` (${sign(jev.unrealizedUsd, 3)} USDT)` : ""}
              </span>
            </div>
            <ExitBar jev={jev} px={px} t={t} />
            <div className={styles.timeLeft}>
              {t("spike.timeLeft")} <b>{plan ? t("spike.min", { n: Math.max(0, Math.round(plan.maxHoldMin - jev.heldMin)) }) : "-"}</b>
              {jev.mfePct != null && jev.maePct != null ? (
                <span style={{ marginLeft: 14 }}>
                  {t("spike.best")} <b className={styles.pos}>{sign(jev.mfePct, 2)}%</b>
                  <span style={{ marginLeft: 10 }}>{t("spike.worst")} <b className={styles.neg}>{sign(jev.maePct, 2)}%</b></span>
                </span>
              ) : null}
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
