/**
 * Alerts for the coin-trade office (coin-trade/): the bot's notable events as messages (sender, subject, body),
 * kept in data/alerts.jsonl so they outlive a restart or a session stop, and served by GET /alerts?after=<id>.
 * Each alert's id grows with time, so a reader asks only for what is newer than the last one it saw.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

export interface Alert { id: number; ts: number; kind: string; sender: string; subject: string; body: string }

const FILE = "data/alerts.jsonl";
const KEEP = 500;

export class Alerts {
  private list: Alert[] = [];
  private last = 0;

  constructor(private file = FILE) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { this.list.push(JSON.parse(line) as Alert); } catch { /* a torn line */ }
      }
      this.list = this.list.slice(-KEEP);
      this.last = this.list.at(-1)?.id ?? 0;
    }
  }

  add(kind: string, subject: string, body: string, sender = "jev-trader 봇"): Alert {
    // The office shows these: no middle dots or dashes there (the bot's own log lines use them).
    const plain = (t: string) => t.replace(/ · /g, ", ").replace(/·/g, ", ").replace(/[—–]/g, "-");
    subject = plain(subject); body = plain(body); sender = plain(sender);
    const id = Math.max(Date.now() * 1000, this.last + 1); // grows even within one millisecond
    this.last = id;
    const a: Alert = { id, ts: Date.now(), kind, sender, subject, body };
    this.list.push(a);
    if (this.list.length > KEEP) this.list.shift();
    try { mkdirSync("data", { recursive: true }); appendFileSync(this.file, JSON.stringify(a) + "\n"); } catch { /* kept in memory */ }
    return a;
  }

  /** Alerts newer than `after` (oldest first, at most `limit`), and the newest id there is. */
  since(after: number, limit = 50): { alerts: Alert[]; last: number } {
    return { alerts: this.list.filter((a) => a.id > after).slice(0, limit), last: this.last };
  }
}
