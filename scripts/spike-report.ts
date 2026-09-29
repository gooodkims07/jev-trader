// Compare Jev with the fade and follow rules on the spike dry run: bun run scripts/spike-report.ts [data/spike.jsonl]
import { existsSync, readFileSync } from "node:fs";

const file = process.argv.slice(2).find((a) => a.endsWith(".jsonl")) ?? "data/spike.jsonl";
if (!existsSync(file)) { console.log(`no spikes yet (${file} is written on the first one)`); process.exit(0); }
// Live and dry-run records are reported apart: pass --live for live ones (default: dry run), --coin XRP-USDT-SWAP to pick a coin.
const wantLive = process.argv.includes("--live");
const ci = process.argv.indexOf("--coin"), coin = ci > 0 ? process.argv[ci + 1] : null;
const rows = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => (r.live ?? false) === wantLive && (!coin || (r.instId ?? "XRP-USDT-SWAP") === coin));
console.log(`${wantLive ? "LIVE" : "DRY RUN"} records${coin ? ` for ${coin}` : ""}`);
const spikes = rows.filter((r) => r.type === "spike");
// Jev's rows that are not Jev's trades (taken over from the OKX app, or closed by hand) are reported apart.
const isManual = (r: any) => r.who === "jev" && (r.manual ?? (r.spikeBlock === -1 || r.reason === "manual"));
const manual = rows.filter((r) => r.type === "trade" && isManual(r));
const trades = rows.filter((r) => r.type === "trade" && !isManual(r));
if (!spikes.length) { console.log("no spikes yet"); process.exit(0); }

const hours = (spikes.at(-1).ts - spikes[0].ts) / 3.6e6;
const asked = spikes.filter((s) => s.asked);
const count = (a: string) => asked.filter((s) => s.jev?.action === a).length;
const byWindow = [...new Set(spikes.map((s) => s.window))].map((w) => `${spikes.filter((s) => s.window === w).length} in ${w}`).join(", ");
console.log(`${spikes.length} spikes over ${hours.toFixed(1)} h (${byWindow}) · Jev asked ${asked.length}: long ${count("buy")}, short ${count("sell")}, stayed out ${count("hold")}`);

// Did Jev fade or follow? Follow = long after an up spike, short after a down spike.
const bySpike = new Map(spikes.map((s) => [s.block, s]));
const style = (t: any) => { const s = bySpike.get(t.spikeBlock); if (!s) return "?"; return (t.side === "buy") === (s.direction === "up") ? "follow" : "fade"; };

const line = (name: string, ts: any[]) => {
  if (!ts.length) return console.log(`  ${name.padEnd(14)} no closed trades`);
  const win = ts.filter((t) => t.pnlPct > 0).length, sum = ts.reduce((a, t) => a + t.pnlPct, 0), usd = ts.reduce((a, t) => a + t.pnlUsd, 0);
  const by = (r: string) => ts.filter((t) => t.reason === r).length;
  console.log(`  ${name.padEnd(14)} ${String(ts.length).padStart(3)} trades · win ${((win / ts.length) * 100).toFixed(0).padStart(3)}% · avg ${(sum / ts.length).toFixed(3).padStart(7)}% (ROE ${((sum / ts.length) * (ts[0].roePct / (ts[0].pnlPct || 1))).toFixed(1).padStart(6)}%) · total ${usd.toFixed(4).padStart(8)} USDT · TP ${by("take-profit")} SL ${by("stop-loss")} time ${by("time")} · avg hold ${(ts.reduce((a, t) => a + t.heldMin, 0) / ts.length).toFixed(0)} min`);
};
console.log("closed trades (fees included; pnl % on notional):");
const jev = trades.filter((t) => t.who === "jev");
line("jev", jev);
line("  jev fading", jev.filter((t) => style(t) === "fade"));
line("  jev following", jev.filter((t) => style(t) === "follow"));
line("manual", manual);
line("rule: fade", trades.filter((t) => t.who === "fade"));
line("rule: follow", trades.filter((t) => t.who === "follow"));
line("rule: trend", trades.filter((t) => t.who === "trend"));

// On the spikes Jev stayed out of, what would the rules have made? (Were the skips good skips?)
const skipped = new Set(asked.filter((s) => s.jev?.action === "hold").map((s) => s.block));
line("fade, Jev out", trades.filter((t) => t.who === "fade" && skipped.has(t.spikeBlock)));
line("follow, Jev out", trades.filter((t) => t.who === "follow" && skipped.has(t.spikeBlock)));

// How far each strategy's trades went before they closed (price %, + in the trade's favour): the share that
// reached each move, to set the take-profit and stop from. Rows from before this was recorded are skipped.
const LEVELS = [0.5, 1, 1.5, 2, 3, 4];
console.log("how far trades went before the close (price move reached: in favour / against):");
for (const who of ["jev", "fade", "follow", "trend"]) {
  const m = trades.filter((t) => t.who === who && t.mfePct !== undefined);
  if (!m.length) { console.log(`  ${who.padEnd(8)} not measured yet`); continue; }
  const avg = (k: string) => (m.reduce((a, t) => a + t[k], 0) / m.length).toFixed(2);
  const cells = LEVELS.map((p) => `${p}%: ${Math.round((m.filter((t) => t.mfePct >= p).length / m.length) * 100)}/${Math.round((m.filter((t) => t.maePct <= -p).length / m.length) * 100)}`);
  console.log(`  ${who.padEnd(8)} ${m.length} trades · avg best +${avg("mfePct")}% worst ${avg("maePct")}% · ${cells.join("  ")}`);
}
