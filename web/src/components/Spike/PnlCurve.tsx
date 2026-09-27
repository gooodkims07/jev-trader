"use client";

import { useEffect, useRef, useState } from "react";
import type { SpikeSnapshot } from "@/lib/types";
import { WHO } from "./SpikeCompare";
import { useLang } from "@/lib/i18n";
import styles from "./Spike.module.css";

/** Cumulative USDT after each closed trade, for Jev and both rules, on one shared scale with a zero line. */
export default function PnlCurve({ snap }: { snap: SpikeSnapshot | null }) {
  const { t } = useLang();
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 600, h: 100 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pts = snap?.curve ?? [];
  const all = pts.flatMap((p) => [p.jev, p.fade, p.follow]);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all), range = hi - lo || 1;
  const { w, h } = size, pad = 4;
  const x = (i: number) => (pts.length < 2 ? w / 2 : pad + (i / (pts.length - 1)) * (w - 2 * pad));
  const y = (v: number) => pad + (1 - (v - lo) / range) * (h - 2 * pad);
  const path = (k: "jev" | "fade" | "follow") => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join(" ");
  const last = pts.at(-1);

  return (
    <div className={styles.curve}>
      <div className={styles.label} style={{ marginBottom: 6 }}>
        <span>{t("spike.curve")}</span>
        <span className={styles.legend}>
          {WHO.map(({ who, name, colour }) => (
            <span key={who}>
              <span className={styles.swatch} style={{ background: colour }} />
              {t(name)} {last ? `${last[who] >= 0 ? "+" : ""}${last[who].toFixed(3)}` : "0"}
            </span>
          ))}
        </span>
      </div>
      <div ref={ref} style={{ flex: 1, minHeight: 0 }}>
        {pts.length === 0 ? (
          <div className={styles.empty}>{t("spike.noTrades")}</div>
        ) : (
          <svg className={styles.curveSvg} viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-label="cumulative profit and loss">
            <line x1={0} x2={w} y1={y(0)} y2={y(0)} stroke="var(--border-2)" strokeDasharray="3 3" />
            {WHO.map(({ who, colour }) => (
              <path key={who} d={path(who)} fill="none" stroke={colour} strokeWidth={who === "jev" ? 2 : 1.4} opacity={who === "jev" ? 1 : 0.8} />
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
