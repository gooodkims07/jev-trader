"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockEvent, ConnectionState, Meta } from "@/lib/types";
import { fmtInt, shortAddr } from "@/lib/format";
import { useVenue } from "@/lib/venue";
import styles from "./Header.module.css";

export interface HeaderProps {
  meta: Meta | null;
  latest: BlockEvent | null;
  connection: ConnectionState;
}

/** Only shown when we are NOT live. Live is the silent, default state. */
const OFFLINE_LABEL: Partial<Record<ConnectionState, string>> = {
  connecting: "connecting",
  reconnecting: "reconnecting",
};

export default function Header({ meta, latest, connection }: HeaderProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  const wallet = meta?.wallet ?? null;
  const venue = useVenue();
  // Only a wallet address is worth copying; an exchange account label is shown as is.
  const isAddress = !!wallet && wallet.startsWith("0x");

  const onCopy = useCallback(() => {
    if (!wallet) return;
    try {
      void navigator.clipboard?.writeText(wallet)?.catch(() => {});
    } catch {
      /* clipboard unavailable, still flash "copied" so the click feels alive */
    }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  }, [wallet]);

  const model = meta?.model ?? null;
  const isJev = (model ?? "").toLowerCase().startsWith("jev");
  const offline = OFFLINE_LABEL[connection] ?? null;

  return (
    <div className={styles.header}>
      <span className={styles.brand}>‖ Jev Trader</span>

      <span className={styles.block}>{venue.clock} {latest ? fmtInt(latest.block) : "-"}</span>

      <span className={styles.spacer} />

      {offline ? <span className={styles.offline}>{offline}</span> : null}

      <button
        type="button"
        className={styles.wallet}
        onClick={onCopy}
        disabled={!isAddress}
        title={wallet ?? "no wallet, dry run"}
        aria-label={isAddress ? `Copy wallet address ${wallet}` : wallet ?? "Dry run"}
      >
        {copied ? "copied" : wallet ? (isAddress ? shortAddr(wallet) : wallet) : "dry run"}
      </button>

      {model ? (
        <span
          className={styles.badge}
          style={{
            background: isJev
              ? "var(--badge-jev-bg)"
              : "var(--badge-standin-bg)",
            color: isJev ? "var(--badge-jev-fg)" : "var(--badge-standin-fg)",
          }}
        >
          {model}
        </span>
      ) : null}
    </div>
  );
}
