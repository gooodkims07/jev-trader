import type { NextConfig } from "next";
import { execSync } from "node:child_process";
import path from "node:path";

const git = (args: string) => {
  try {
    return execSync(`git ${args}`, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};

/**
 * The build shown in the header: the commit (Vercel's, else the local checkout's, "+" when it has
 * uncommitted changes) and when this bundle was built, in Korean time. Baked in at build time.
 */
const sha = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || git("rev-parse --short HEAD") || "dev";
const dirty = !process.env.VERCEL_GIT_COMMIT_SHA && git("status --porcelain") ? "+" : "";
const builtAt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
}).format(new Date());

const nextConfig: NextConfig = {
  // The repo root also has a bun.lock; pin the workspace root to this app.
  turbopack: { root: path.resolve(__dirname) },
  env: { BUILD_SHA: sha + dirty, BUILD_TIME: builtAt },
};

export default nextConfig;
