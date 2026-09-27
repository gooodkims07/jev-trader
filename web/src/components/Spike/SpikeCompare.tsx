"use client";

import type { SpikeSnapshot, Who } from "@/lib/types";
import styles from "./Spike.module.css";

export const WHO: { who: Who; name: string; colour: string }[] = [
  { who: "jev", name: "Jev", colour: "var(--link)" },
  { who: "fade", name: "Fade", colour: "var(--buy)" },
  { who: "follow", name: "Follow", colour: "var(--late)" },
];

/** Jev against the two rules that shadow every spike with the same exits. */
export default function SpikeCompare({ snap }: { snap: SpikeSnapshot | null }) {
  return (
    <section className={styles.section}>
      <div className={styles.label}>
        <span>JEV VS RULES</span>
        <span className={styles.labelNote}>fees included</span>
      </div>
      <table className={styles.table}>
        <thead>
          <tr><th>strategy</th><th>trades</th><th>win</th><th>avg</th><th>TP/SL/time</th><th>USDT</th></tr>
        </thead>
        <tbody>
          {WHO.map(({ who, name, colour }) => {
            const s = snap?.stats[who];
            const n = s?.trades ?? 0;
            return (
              <tr key={who}>
                <td className={styles.who}><span className={styles.swatch} style={{ background: colour }} />{name}</td>
                <td>{n}</td>
                <td>{n ? `${Math.round(((s!.wins) / n) * 100)}%` : "-"}</td>
                <td className={n ? (s!.avgPct >= 0 ? styles.pos : styles.neg) : ""}>{n ? `${s!.avgPct >= 0 ? "+" : ""}${s!.avgPct.toFixed(2)}%` : "-"}</td>
                <td>{n ? `${s!.tp}/${s!.sl}/${s!.time}` : "-"}</td>
                <td className={n ? (s!.totalUsd >= 0 ? styles.pos : styles.neg) : ""}>{n ? `${s!.totalUsd >= 0 ? "+" : ""}${s!.totalUsd.toFixed(3)}` : "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.note}>Fade trades against every spike, Follow with it. Jev only trades when it chooses to.</div>
    </section>
  );
}
