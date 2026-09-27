"use client";

import type { SpikeRow, SpikeSnapshot } from "@/lib/types";
import styles from "./Spike.module.css";

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function choice(s: SpikeRow): { text: string; colour: string } {
  if (!s.asked || !s.jev) return { text: "not asked (in a trade)", colour: "var(--muted-2)" };
  const a = s.jev.action;
  if (a === "hold") return { text: `stay out ${Math.round(s.jev.probabilities.hold * 100)}%`, colour: "var(--muted)" };
  const follow = (a === "buy") === (s.direction === "up");
  const p = Math.round((a === "buy" ? s.jev.probabilities.buy : s.jev.probabilities.sell) * 100);
  return { text: `${a === "buy" ? "long" : "short"} ${p}% (${follow ? "follow" : "fade"})`, colour: a === "buy" ? "var(--buy-ink)" : "var(--sell-ink)" };
}

function outcome(s: SpikeRow): { text: string; cls: string } {
  if (s.trade) {
    const r = s.trade.reason === "take-profit" ? "TP" : s.trade.reason === "stop-loss" ? "SL" : "time";
    return { text: `${r} ${s.trade.roePct >= 0 ? "+" : ""}${s.trade.roePct.toFixed(1)}%`, cls: s.trade.pnlUsd >= 0 ? styles.pos : styles.neg };
  }
  if (s.jevOpen) return { text: "open", cls: "" };
  return { text: "", cls: styles.dim };
}

/** Every spike, newest first: when, how big, what Jev chose, and how Jev's trade ended (ROE). */
export default function SpikeList({ snap }: { snap: SpikeSnapshot | null }) {
  const rows = snap?.spikes ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className={`${styles.label} ${styles.listLabel}`} style={{ marginBottom: 0 }}>
        <span>SPIKES</span>
        <span className={styles.labelNote}>{rows.length ? `${rows.length} latest` : ""}</span>
      </div>
      <div className={styles.list}>
        {rows.length === 0 ? (
          <div className={styles.empty}>No spike yet. About 7 a day on XRP at these triggers.</div>
        ) : (
          rows.map((s) => {
            const c = choice(s), o = outcome(s);
            return (
              <div key={s.block} className={styles.row}>
                <span className={`${styles.mono} ${styles.time}`}>{hhmm(s.ts)}</span>
                <span className={styles.mono} style={{ color: s.direction === "up" ? "var(--buy-ink)" : "var(--sell-ink)" }}>
                  {s.movePct >= 0 ? "+" : ""}{s.movePct.toFixed(2)}% {s.window}
                </span>
                <span style={{ color: c.colour }}>{c.text}</span>
                <span className={`${styles.mono} ${styles.right} ${o.cls}`}>{o.text}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
