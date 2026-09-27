"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLang, type Key } from "@/lib/i18n";
import styles from "./Settings.module.css";

interface Field { key: string; group: "clock" | "spike" | "size" | "risk" | "mm"; value: number; min: number; max: number; step: number; unit: string; options: number[] | null }
interface View {
  editable: boolean;
  strategy: "mm" | "spike";
  fields: Field[];
  fixed: { venue: string; market: string; strategy: string; live: boolean; model: string; leverage: number | null; tickMs: number | null; horizonBlocks: number; lookbackBlocks: number };
}

const TOKEN = "jev.adminToken";
const GROUPS: Field["group"][] = ["clock", "spike", "size", "risk", "mm"];

/**
 * GET /settings shows every value; POST /settings changes the editable ones (server needs ADMIN_TOKEN, the
 * viewer enters it once). Only changed fields are sent; the server validates all of them or applies none.
 */
export default function SettingsPanel({ apiUrl, onClose }: { apiUrl: string; onClose: () => void }) {
  const { t } = useLang();
  const base = (apiUrl || "").replace(/\/+$/, "");
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${base}/settings`, { cache: "no-store" });
      const v = (await r.json()) as View;
      setView(v);
      setDraft(Object.fromEntries(v.fields.map((f) => [f.key, String(f.value)])));
    } catch {
      setMsg({ kind: "bad", text: t("settings.loadFailed") });
    }
  }, [base, t]);

  // Load once when the panel opens. The page re-renders every tick and hands us a new onClose each time;
  // reloading on that would overwrite what the viewer is typing, so onClose goes through a ref.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    loadRef.current();
    try { setToken(localStorage.getItem(TOKEN) ?? ""); } catch { /* not remembered */ }
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  const changed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of view?.fields ?? []) {
      const v = Number(draft[f.key]);
      if (draft[f.key] !== undefined && draft[f.key] !== "" && Number.isFinite(v) && v !== f.value) out[f.key] = v;
    }
    return out;
  }, [draft, view]);

  const save = async () => {
    setSaving(true); setErrors({}); setMsg(null);
    try {
      try { localStorage.setItem(TOKEN, token); } catch { /* not remembered */ }
      const r = await fetch(`${base}/settings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(changed) });
      const body = await r.json();
      if (r.ok) {
        setView(body as View);
        setDraft(Object.fromEntries((body as View).fields.map((f) => [f.key, String(f.value)])));
        setMsg({ kind: "good", text: t("settings.saved") });
      } else {
        if (body?.errors) setErrors(body.errors);
        setMsg({ kind: "bad", text: r.status === 401 ? t("settings.unauthorized") : `${t("settings.error")}: ${body?.error ?? r.status}` });
      }
    } catch (e) {
      setMsg({ kind: "bad", text: `${t("settings.error")}: ${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  };

  const fixedRows: [Key, string][] = view
    ? [
        ["fixed.venue", view.fixed.venue],
        ["fixed.market", view.fixed.market],
        ["fixed.strategy", view.fixed.strategy],
        ["fixed.live", t(view.fixed.live ? "fixed.yes" : "fixed.no")],
        ["fixed.model", view.fixed.model],
        ...(view.fixed.leverage !== null ? ([["fixed.leverage", `${view.fixed.leverage}x`]] as [Key, string][]) : []),
        ...(view.fixed.tickMs !== null ? ([["fixed.tickMs", `${view.fixed.tickMs} ms`]] as [Key, string][]) : []),
        ...(view.strategy === "mm" ? ([["fixed.horizonBlocks", String(view.fixed.horizonBlocks)], ["fixed.lookbackBlocks", String(view.fixed.lookbackBlocks)]] as [Key, string][]) : []),
      ]
    : [];

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("settings.title")}>
        <div className={styles.head}>
          <span className={styles.title}>{t("settings.title")}</span>
          <button type="button" className={styles.button} onClick={onClose}>{t("settings.close")}</button>
        </div>
        <div className={styles.body}>
          {view && !view.editable ? <div className={styles.notice}>{t("settings.readOnly")}</div> : null}
          {GROUPS.map((g) => {
            const fs = view?.fields.filter((f) => f.group === g) ?? [];
            if (!fs.length) return null;
            return (
              <div key={g} className={styles.group}>
                <div className={styles.groupLabel}>{t(`settings.group.${g}` as Key)}</div>
                {fs.map((f) => (
                  <div key={f.key} className={styles.field}>
                    <label htmlFor={f.key}>{t(`field.${f.key}` as Key)}</label>
                    {f.options ? (
                      <select
                        id={f.key}
                        className={`${styles.input} ${f.key in changed ? styles.changed : ""}`}
                        value={draft[f.key] ?? ""} disabled={!view?.editable}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      >
                        {f.options.map((o) => (
                          <option key={o} value={String(o)}>{o >= 60_000 ? t("tick.min", { n: o / 60_000 }) : t("tick.s", { n: o / 1000 })}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={f.key}
                        className={`${styles.input} ${f.key in changed ? styles.changed : ""}`}
                        type="number" inputMode="decimal" min={f.min} max={f.max} step={f.step}
                        value={draft[f.key] ?? ""} disabled={!view?.editable}
                        onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                      />
                    )}
                    <span className={styles.unit}>{f.options ? "" : f.unit === "min" ? t("unit.min") : f.unit === "s" ? t("unit.s") : f.unit}</span>
                    {errors[f.key] ? <span className={styles.err}>{errors[f.key]}</span> : null}
                  </div>
                ))}
              </div>
            );
          })}
          {view ? (
            <div className={styles.group}>
              <div className={styles.groupLabel}>{t("settings.fixed")}</div>
              <div className={styles.fixed}>
                {fixedRows.map(([k, v]) => (
                  <Fragment key={k}><span className={styles.fixedKey}>{t(k)}</span><span className={styles.mono}>{v}</span></Fragment>
                ))}
              </div>
              <div className={styles.note}>{t("settings.liveNote")}</div>
            </div>
          ) : null}
          {view?.editable ? (
            <div className={styles.group}>
              <div className={styles.groupLabel}>{t("settings.token")}</div>
              <input className={styles.input} style={{ textAlign: "left" }} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
              <div className={styles.note}>{t("settings.tokenHint")}</div>
            </div>
          ) : null}
          {msg ? <div className={`${styles.notice} ${msg.kind === "good" ? styles.good : styles.bad}`}>{msg.text}</div> : null}
        </div>
        <div className={styles.foot}>
          <button type="button" className={`${styles.button} ${styles.primary}`} disabled={!view?.editable || saving || !Object.keys(changed).length || !token} onClick={save}>
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
