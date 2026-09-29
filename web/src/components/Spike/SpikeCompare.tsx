"use client";

import type { SpikeSnapshot, SpikeStat, Who } from "@/lib/types";
import { useLang, type Key } from "@/lib/i18n";
import styles from "./Spike.module.css";

export const WHO: { who: Who; name: Key; colour: string }[] = [
  { who: "jev", name: "spike.who.jev", colour: "var(--link)" },
  { who: "fade", name: "spike.who.fade", colour: "var(--buy)" },
  { who: "follow", name: "spike.who.follow", colour: "var(--late)" },
];

/** Trades taken over from the OKX app or closed by hand: shown apart, so Jev's row is Jev's own. */
export const MANUAL_COLOUR = "var(--muted-2)";

/** Jev against the two rules that shadow every spike with the same exits; manual trades apart; how far trades went. */
export default function SpikeCompare({ snap }: { snap: SpikeSnapshot | null }) {
  const { t } = useLang();
  const row = (key: string, label: string, colour: string, s: SpikeStat | undefined) => {
    const n = s?.trades ?? 0;
    return (
      <tr key={key}>
        <td className={styles.who}><span className={styles.swatch} style={{ background: colour }} />{label}</td>
        <td>{n}</td>
        <td>{n ? `${Math.round(((s!.wins) / n) * 100)}%` : "-"}</td>
        <td className={n ? (s!.avgPct >= 0 ? styles.pos : styles.neg) : ""}>{n ? `${s!.avgPct >= 0 ? "+" : ""}${s!.avgPct.toFixed(2)}%` : "-"}</td>
        <td>{n ? `${s!.tp}/${s!.sl}/${s!.time}` : "-"}</td>
        <td className={n ? (s!.totalUsd >= 0 ? styles.pos : styles.neg) : ""}>{n ? `${s!.totalUsd >= 0 ? "+" : ""}${s!.totalUsd.toFixed(3)}` : "-"}</td>
      </tr>
    );
  };
  const manual = snap?.stats.manual;
  const ex = snap?.excursions;
  const plan = snap?.plan;
  const pctOf = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "-");
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
          {WHO.map(({ who, name, colour }) => row(who, t(name), colour, snap?.stats[who]))}
          {manual && manual.trades ? row("manual", t("spike.who.manual"), MANUAL_COLOUR, manual) : null}
        </tbody>
      </table>
      <div className={styles.note}>{t("spike.vsNote")}{manual && manual.trades ? ` ${t("spike.manualNote")}` : ""}</div>
      {ex ? (
        <>
          <div className={styles.label} style={{ marginTop: 12 }}>
            <span>{t("spike.reach")}</span>
            <span className={styles.labelNote}>{t("spike.reachMeasured", { n: ex.jev.measured })}</span>
          </div>
          {ex.jev.measured ? (
            <table className={`${styles.table} ${styles.reachTable}`}>
              <thead>
                <tr><th>{t("spike.reach.move")}</th>{ex.jev.reach.map((r) => <th key={r.pct} className={plan && (r.pct === +plan.takeProfitPct.toFixed(2) || r.pct === +plan.stopLossPct.toFixed(2)) ? styles.reachMark : undefined}>{r.pct}%</th>)}</tr>
              </thead>
              <tbody>
                <tr><td className={styles.pos}>{t("spike.reach.fav")}</td>{ex.jev.reach.map((r) => <td key={r.pct}>{pctOf(r.fav, ex.jev.measured)}</td>)}</tr>
                <tr><td className={styles.neg}>{t("spike.reach.adv")}</td>{ex.jev.reach.map((r) => <td key={r.pct}>{pctOf(r.adv, ex.jev.measured)}</td>)}</tr>
              </tbody>
            </table>
          ) : (
            <div className={styles.flat}>{t("spike.reachNone")}</div>
          )}
          {ex.jev.measured ? (
            <div className={styles.note}>
              {t("spike.reachAvg", { fav: `+${ex.jev.mfeAvg.toFixed(2)}`, adv: ex.jev.maeAvg.toFixed(2) })}
              {plan ? ` ${t("spike.reachPlan", { tp: +plan.takeProfitPct.toFixed(2), sl: +plan.stopLossPct.toFixed(2) })}` : ""}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
