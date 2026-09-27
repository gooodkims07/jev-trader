"use client";

import type { SpikeSnapshot } from "@/lib/types";
import { useVenue } from "@/lib/venue";
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
export default function SpikeStatus({ snap }: { snap: SpikeSnapshot | null }) {
  const venue = useVenue();
  const plan = snap?.plan;
  const jev = snap?.open.find((o) => o.who === "jev") ?? null;
  const px = (n: number) => n.toFixed(venue.priceDecimals);
  return (
    <>
      <section className={styles.section}>
        <div className={styles.label}>
          <span>JEV POSITION</span>
          {plan ? (
            <span className={styles.labelNote}>
              TP +{plan.takeProfitRoePct}% / SL -{plan.stopLossRoePct}% ROE at {plan.leverage}x
            </span>
          ) : null}
        </div>
        {jev ? (
          <>
            <div className={styles.posHead}>
              <span className={styles.posWord} style={{ color: jev.side === "buy" ? "var(--buy-ink)" : "var(--sell-ink)" }}>
                {jev.side === "buy" ? "LONG" : "SHORT"} {plan?.size} {plan?.base}
              </span>
              <span className={`${styles.posRoe} ${jev.unrealizedRoePct >= 0 ? styles.pos : styles.neg}`}>
                ROE {sign(jev.unrealizedRoePct, 1)}%
              </span>
            </div>
            <div className={styles.kv}>
              <div><div className={styles.k}>ENTRY</div><div className={styles.v}>{px(jev.entry)}</div></div>
              <div><div className={styles.k}>TAKE PROFIT</div><div className={styles.v}>{px(jev.tp)}</div></div>
              <div><div className={styles.k}>STOP</div><div className={styles.v}>{px(jev.sl)}</div></div>
              <div>
                <div className={styles.k}>TIME LEFT</div>
                <div className={styles.v}>{plan ? `${Math.max(0, Math.round(plan.maxHoldMin - jev.heldMin))} min` : "-"}</div>
              </div>
            </div>
          </>
        ) : (
          <div className={styles.flat}>flat, waiting for a spike</div>
        )}
      </section>
      <section className={styles.section}>
        <div className={styles.label}>
          <span>DISTANCE TO A SPIKE</span>
          <span className={styles.labelNote}>
            {snap && snap.gauge.cooldownSec > 0 ? `cooldown ${snap.gauge.cooldownSec}s` : plan ? `trigger ${plan.move1mPct}% / 1m or ${plan.move3mPct}% / 3m` : ""}
          </span>
        </div>
        <Gauge label="1m" pct={snap?.gauge.r1Pct ?? null} threshold={plan?.move1mPct ?? 0.5} />
        <Gauge label="3m" pct={snap?.gauge.r3Pct ?? null} threshold={plan?.move3mPct ?? 0.8} />
      </section>
    </>
  );
}
