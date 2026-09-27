// Compare Jev with the fade and follow rules on the spike dry run: bun run scripts/spike-report.ts [data/spike.jsonl]
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2] ?? "data/spike.jsonl", "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const spikes = rows.filter((r) => r.type === "spike");
const trades = rows.filter((r) => r.type === "trade");
if (!spikes.length) { console.log("no spikes yet"); process.exit(0); }

const hours = (spikes.at(-1).ts - spikes[0].ts) / 3.6e6;
const asked = spikes.filter((s) => s.asked);
const count = (a: string) => asked.filter((s) => s.jev?.action === a).length;
console.log(`${spikes.length} spikes over ${hours.toFixed(1)} h (${spikes.filter((s) => s.window === "1m").length} in 1m, ${spikes.filter((s) => s.window === "3m").length} in 3m) · Jev asked ${asked.length}: long ${count("buy")}, short ${count("sell")}, stayed out ${count("hold")}`);

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
line("rule: fade", trades.filter((t) => t.who === "fade"));
line("rule: follow", trades.filter((t) => t.who === "follow"));

// On the spikes Jev stayed out of, what would the rules have made? (Were the skips good skips?)
const skipped = new Set(asked.filter((s) => s.jev?.action === "hold").map((s) => s.block));
line("fade, Jev out", trades.filter((t) => t.who === "fade" && skipped.has(t.spikeBlock)));
line("follow, Jev out", trades.filter((t) => t.who === "follow" && skipped.has(t.spikeBlock)));
