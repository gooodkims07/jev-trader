"use client";

import type { SpikeRow, SpikeSnapshot } from "@/lib/types";
import { useLang, type T } from "@/lib/i18n";
import styles from "./Spike.module.css";

const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function choice(s: SpikeRow, t: T): { text: string; colour: string } {
  if (!s.asked || !s.jev) return { text: t("spike.notAsked"), colour: "var(--muted-2)" };
  const a = s.jev.action;
  if (a === "hold") return { text: t("spike.stayOut", { p: Math.round(s.jev.probabilities.hold * 100) }), colour: "var(--muted)" };
  const follow = (a === "buy") === (s.direction === "up");
  const p = Math.round((a === "buy" ? s.jev.probabilities.buy : s.jev.probabilities.sell) * 100);
  return { text: t("spike.choice", { side: t(a === "buy" ? "chart.long" : "chart.short"), p, style: t(follow ? "spike.follow" : "spike.fade") }), colour: a === "buy" ? "var(--buy-ink)" : "var(--sell-ink)" };
}

function outcome(s: SpikeRow, t: T): { text: string; cls: string } {
  if (s.trade) {
    const r = s.trade.reason === "take-profit" ? "TP" : s.trade.reason === "stop-loss" ? "SL" : t("spike.time");
    return { text: `${r} ${s.trade.roePct >= 0 ? "+" : ""}${s.trade.roePct.toFixed(1)}%`, cls: s.trade.pnlUsd >= 0 ? styles.pos : styles.neg };
  }
  if (s.jevOpen) return { text: t("spike.open"), cls: "" };
  return { text: "", cls: styles.dim };
}

/** Every spike, newest first: when, how big, what Jev chose, and how Jev's trade ended (ROE). */
export default function SpikeList({ snap }: { snap: SpikeSnapshot | null }) {
  const { t } = useLang();
  const rows = snap?.spikes ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className={`${styles.label} ${styles.listLabel}`} style={{ marginBottom: 0 }}>
        <span>{t("spike.list")}</span>
        <span className={styles.labelNote}>{rows.length ? t("spike.latest", { n: rows.length }) : ""}</span>
      </div>
      <div className={styles.list}>
        {rows.length === 0 ? (
          <div className={styles.empty}>{t("spike.none")}</div>
        ) : (
          rows.map((s) => {
            const c = choice(s, t), o = outcome(s, t);
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
