/**
 * OKX v5 REST: public market data and signed account/trade calls.
 *
 * Auth (docs-v5 "REST Authentication"): OK-ACCESS-SIGN = base64(HMAC-SHA256(secret,
 * timestamp + METHOD + requestPath + body)), requestPath including the query string, timestamp in
 * ISO 8601 with milliseconds. Requests more than 30 s off server time are rejected (50102), so the
 * clock offset to /api/v5/public/time is measured once and applied. Demo trading adds
 * `x-simulated-trading: 1` and needs a key created under Demo Trading.
 */
import { createHmac } from "node:crypto";

export const OKX_REST = "https://www.okx.com";
export const okxWs = (demo: boolean, kind: "public" | "private") =>
  `wss://${demo ? "wspap" : "ws"}.okx.com:8443/ws/v5/${kind}`;

export type Params = Record<string, string>;

/** Every v5 response: code "0" on success. Per-order results carry their own sCode/sMsg. */
interface Envelope<T> { code: string; msg: string; data: T }

export class OkxError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`okx ${status} ${code}: ${message}`);
  }
  /** Worth retrying later: rate limited (50011), server side, or never reached OKX. */
  get transient() { return this.status === 0 || this.status >= 500 || this.code === "50011" || this.code === "50001"; }
}

export const sign = (secret: string, prehash: string) => createHmac("sha256", secret).update(prehash).digest("base64");

export class OkxApi {
  /** Server time minus local time, ms. */
  private offsetMs = 0;

  constructor(
    private readonly key?: string,
    private readonly secret?: string,
    private readonly passphrase?: string,
    readonly demo = true,
    private readonly timeoutMs = 3000,
  ) {}

  get authed() { return !!(this.key && this.secret && this.passphrase); }

  /** Measure the offset to OKX's clock so signed timestamps stay inside the 30 s window. */
  async syncTime() {
    const t0 = Date.now();
    const [r] = await this.public<{ ts: string }[]>("/api/v5/public/time");
    this.offsetMs = Number(r!.ts) - Math.round((t0 + Date.now()) / 2);
  }

  now() { return Date.now() + this.offsetMs; }

  /** Login args for the private WebSocket: sign over unix seconds + GET + /users/self/verify. */
  wsLogin() {
    if (!this.authed) throw new Error("okx: OKX_API_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE are required");
    const timestamp = String(Math.floor(this.now() / 1000));
    return { apiKey: this.key!, passphrase: this.passphrase!, timestamp, sign: sign(this.secret!, `${timestamp}GET/users/self/verify`) };
  }

  public<T>(path: string, params: Params = {}): Promise<T> {
    const q = new URLSearchParams(params).toString();
    return this.request<T>("GET", path + (q ? `?${q}` : ""), {});
  }

  /** Signed call. GET params go in the query string (and the signature), POST params in a JSON body. */
  signed<T>(method: "GET" | "POST", path: string, params: Params | Params[] = {}): Promise<T> {
    if (!this.authed) throw new Error("okx: OKX_API_KEY, OKX_SECRET_KEY and OKX_PASSPHRASE are required");
    let requestPath = path, body = "";
    if (method === "GET") {
      const q = new URLSearchParams(params as Params).toString();
      if (q) requestPath += `?${q}`;
    } else {
      body = JSON.stringify(params);
    }
    const timestamp = new Date(this.now()).toISOString();
    const headers: Record<string, string> = {
      "OK-ACCESS-KEY": this.key!,
      "OK-ACCESS-SIGN": sign(this.secret!, timestamp + method + requestPath + body),
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": this.passphrase!,
      "content-type": "application/json",
    };
    return this.request<T>(method, requestPath, headers, body || undefined);
  }

  private async request<T>(method: string, pathAndQuery: string, headers: Record<string, string>, body?: string): Promise<T> {
    if (this.demo) headers["x-simulated-trading"] = "1";
    let res: Response;
    try {
      res = await fetch(OKX_REST + pathAndQuery, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new OkxError(0, "network", (e as Error).message);
    }
    const text = await res.text();
    let json: Envelope<T> | null = null;
    try { json = JSON.parse(text); } catch {}
    if (!res.ok || !json || json.code !== "0") {
      // Batch-style endpoints put the useful reason in data[0].sCode / sMsg.
      const first = Array.isArray(json?.data) ? (json!.data as any[])[0] : null;
      const code = first?.sCode && first.sCode !== "0" ? first.sCode : json?.code ?? "http";
      const msg = first?.sMsg || json?.msg || text.slice(0, 200);
      throw new OkxError(res.status, code, msg);
    }
    return json.data;
  }
}

/** Decimals needed to write a multiple of `step` exactly ("0.00001" -> 5). */
export const stepDecimals = (step: string) => (step.includes(".") ? step.split(".")[1]!.replace(/0+$/, "").length : 0);

/** A client order id OKX accepts: letters and digits, at most 32. Ours start with "jev". */
export const newClOrdId = () => "jev" + crypto.randomUUID().replaceAll("-", "").slice(0, 29);
