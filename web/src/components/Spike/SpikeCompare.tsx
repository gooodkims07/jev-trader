"use client";

import type { SpikeSnapshot, Who } from "@/lib/types";
import { useLang, type Key } from "@/lib/i18n";
import styles from "./Spike.module.css";

export const WHO: { who: Who; name: Key; colour: string }[] = [
  { who: "jev", name: "spike.who.jev", colour: "var(--link)" },
  { who: "fade", name: "spike.who.fade", colour: "var(--buy)" },
  { who: "follow", name: "spike.who.follow", colour: "var(--late)" },
];

/** Jev against the two rules that shadow every spike with the same exits. */
export default function SpikeCompare({ snap }: { snap: SpikeSnapshot | null }) {
  const { t } = useLang();
  return (
    <section className={styles.section}>
      <div className={styles.label}>
        <span>{t("spike.vs")}</span>
        <span className={styles.labelNote}>{t("spike.feesIncluded")}</span>
      </div>
      <table className={styles.table}>
        <thead>
          <tr><th>{t("spike.col.strategy")}</th><th>{t("spike.col.trades")}</th><th>{t("spike.col.win")}</th><th>{t("spike.col.avg")}</th><th>{t("spike.col.exits")}</th><th>{t("spike.col.usdt")}</th></tr>
        </thead>
        <tbody>
          {WHO.map(({ who, name, colour }) => {
            const s = snap?.stats[who];
            const n = s?.trades ?? 0;
            return (
              <tr key={who}>
                <td className={styles.who}><span className={styles.swatch} style={{ background: colour }} />{t(name)}</td>
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
      <div className={styles.note}>{t("spike.vsNote")}</div>
    </section>
  );
}
