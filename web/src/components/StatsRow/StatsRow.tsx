"use client";

import { useEffect, useState } from "react";
import type { BlockEvent, Meta } from "@/lib/types";
import { fmtInt, uptime } from "@/lib/format";
import { useLang } from "@/lib/i18n";
import styles from "./StatsRow.module.css";

const DASH = "-";

export default function StatsRow({
  latest,
  avgLatencyMs,
  meta,
}: {
  latest: BlockEvent | null;
  avgLatencyMs: number;
  meta: Meta | null;
}) {
  const { t } = useLang();
  const startedAt = meta?.startedAt ?? null;
  // Ticks once a second; starts on the client so SSR and hydration agree.
  const [up, setUp] = useState<string | null>(null);

  useEffect(() => {
    if (startedAt == null) {
      setUp(null);
      return;
    }
    const tick = () => setUp(uptime(startedAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const decision = latest?.decision ?? null;
  const last = decision && !decision.late ? `${decision.latencyMs} ms` : `${DASH} ms`;
  const avg =
    Number.isFinite(avgLatencyMs) && avgLatencyMs > 0 ? `${Math.round(avgLatencyMs)}ms` : DASH;
  const totals = latest?.totals ?? null;

  return (
    <div className={styles.stats}>
      <span>{t("stats.last")} {last}</span>
      <span>{t("stats.avg")} {avg}</span>
      <span className={styles.nowrap}>{totals ? fmtInt(totals.decisions) : DASH} {t("stats.calls")}</span>
      <span className={styles.nowrap}>{totals ? fmtInt(totals.fills) : DASH} {t("stats.fills")}</span>
      <span className={styles.spacer} />
      <span>{t("stats.uptime")} {up ?? "00:00:00"}</span>
    </div>
  );
}
