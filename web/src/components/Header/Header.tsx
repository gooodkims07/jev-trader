"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockEvent, ConnectionState, Meta } from "@/lib/types";
import { fmtInt, shortAddr } from "@/lib/format";
import { useVenue } from "@/lib/venue";
import { useLang, type Key } from "@/lib/i18n";
import styles from "./Header.module.css";

export interface HeaderProps {
  meta: Meta | null;
  latest: BlockEvent | null;
  connection: ConnectionState;
  /** Opens the settings panel; the button is hidden when absent. */
  onSettings?: () => void;
}

/** Only shown when we are NOT live. Live is the silent, default state. */
const OFFLINE_LABEL: Partial<Record<ConnectionState, Key>> = {
  connecting: "header.connecting",
  reconnecting: "header.reconnecting",
};

export default function Header({ meta, latest, connection, onSettings }: HeaderProps) {
  const { t, lang, setLang } = useLang();
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
  const offlineKey = OFFLINE_LABEL[connection];
  const offline = offlineKey ? t(offlineKey) : null;

  return (
    <div className={styles.header}>
      <span className={styles.brand}>‖ Jev Trader</span>

      <span className={styles.block}>{t(venue.clock === "block" ? "clock.block" : "clock.tick")} {latest ? fmtInt(latest.block) : "-"}</span>

      <span className={styles.spacer} />

      {offline ? <span className={styles.offline}>{offline}</span> : null}

      <button
        type="button"
        className={styles.wallet}
        onClick={onCopy}
        disabled={!isAddress}
        title={wallet ?? t("header.noWallet")}
        aria-label={isAddress ? `Copy wallet address ${wallet}` : wallet ?? t("header.dryRun")}
      >
        {copied ? t("header.copied") : wallet ? (isAddress ? shortAddr(wallet) : wallet) : t("header.dryRun")}
      </button>

      {venue.name !== "kuru" ? (
        // The Kuru demo is the public page behind the tweet: it stays as it was, in English, with no controls.
        <button type="button" className={styles.wallet} onClick={() => setLang(lang === "ko" ? "en" : "ko")} aria-label="language">
          {t("header.otherLang")}
        </button>
      ) : null}

      {onSettings ? (
        <button type="button" className={styles.wallet} onClick={onSettings}>
          {t("header.settings")}
        </button>
      ) : null}

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
