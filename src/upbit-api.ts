/**
 * Upbit REST: public quotation calls and JWT-signed exchange calls.
 *
 * Auth (docs.upbit.com/kr/reference/auth): HS512 JWT with access_key, a fresh uuid nonce, and, when
 * the request has parameters, query_hash = sha512 hex of the NON-URL-encoded query string
 * ("k=v&k=v", in the order sent). POST bodies are hashed the same way from their JSON fields.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

export const UPBIT_REST = "https://api.upbit.com";
export const UPBIT_WS = "wss://api.upbit.com/websocket/v1";
export const UPBIT_WS_PRIVATE = "wss://api.upbit.com/websocket/v1/private";

export type Params = Record<string, string>;

/** Order object returned by POST /v1/orders, DELETE /v1/order and GET /v1/orders/open. Numbers are strings. */
export interface UpbitOrder {
  uuid: string;
  side: "bid" | "ask";
  ord_type: string;
  price: string | null;
  state: "wait" | "watch" | "done" | "cancel" | "prevented";
  market: string;
  volume: string | null;
  remaining_volume: string | null;
  executed_volume: string;
  paid_fee: string;
  identifier?: string;
}

export interface UpbitAccount { currency: string; balance: string; locked: string; unit_currency: string }

export class UpbitError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`upbit ${status} ${code}: ${message}`);
  }
  /** Worth retrying later: rate limited, server side, or never reached Upbit. */
  get transient() { return this.status === 0 || this.status === 429 || this.status >= 500; }
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");
const JWT_HEADER = b64url(JSON.stringify({ alg: "HS512", typ: "JWT" }));

/** "k=v&k=v" exactly as sent, not URL encoded: the string query_hash is computed over. */
export const queryString = (p: Params) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join("&");

export function signJwt(accessKey: string, secretKey: string, query = ""): string {
  const payload: Record<string, string> = { access_key: accessKey, nonce: randomUUID() };
  if (query) {
    payload.query_hash = createHash("sha512").update(query, "utf8").digest("hex");
    payload.query_hash_alg = "SHA512";
  }
  const unsigned = `${JWT_HEADER}.${b64url(JSON.stringify(payload))}`;
  return `${unsigned}.${createHmac("sha512", secretKey).update(unsigned).digest("base64url")}`;
}

export class UpbitApi {
  constructor(private readonly accessKey?: string, private readonly secretKey?: string, private readonly timeoutMs = 3000) {}

  get authed() { return !!(this.accessKey && this.secretKey); }

  /** Authorization header value for a request with this query string (or none). */
  auth(query = "") {
    if (!this.authed) throw new Error("upbit: UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY are required");
    return `Bearer ${signJwt(this.accessKey!, this.secretKey!, query)}`;
  }

  /** Quotation API: no auth, limited per IP (10 req/s per group). */
  quote<T>(path: string, params: Params = {}): Promise<T> {
    const q = queryString(params);
    return this.request<T>("GET", path + (q ? `?${q}` : ""), {});
  }

  /** Exchange API. GET/DELETE carry params in the query string, POST in a JSON body. */
  exchange<T>(method: "GET" | "POST" | "DELETE", path: string, params: Params = {}): Promise<T> {
    const q = queryString(params);
    const headers: Record<string, string> = { authorization: this.auth(q) };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      return this.request<T>(method, path, headers, JSON.stringify(params));
    }
    return this.request<T>(method, path + (q ? `?${q}` : ""), headers);
  }

  private async request<T>(method: string, pathAndQuery: string, headers: Record<string, string>, body?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(UPBIT_REST + pathAndQuery, { method, headers: { accept: "application/json", ...headers }, body, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new UpbitError(0, "network", (e as Error).message);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new UpbitError(res.status, json?.error?.name ?? "http", json?.error?.message ?? text.slice(0, 200));
    return json as T;
  }
}

/**
 * KRW market price unit (호가 단위) for a price. Prices must be a multiple of the unit for the range
 * they fall in. docs.upbit.com/kr/docs/krw-market-info
 */
export function krwTick(price: number): number {
  if (price >= 1_000_000) return 1000;
  if (price >= 500_000) return 500;
  if (price >= 100_000) return 100;
  if (price >= 50_000) return 50;
  if (price >= 10_000) return 10;
  if (price >= 5_000) return 5;
  if (price >= 100) return 1;
  if (price >= 10) return 0.1;
  if (price >= 1) return 0.01;
  if (price >= 0.1) return 0.001;
  if (price >= 0.01) return 0.0001;
  if (price >= 0.001) return 0.00001;
  if (price >= 0.0001) return 0.000001;
  if (price >= 0.00001) return 0.0000001;
  return 0.00000001;
}

/** Decimals needed to write a multiple of `tick` exactly. */
export const tickDecimals = (tick: number) => (tick >= 1 ? 0 : Math.round(-Math.log10(tick)));

/** Upbit's minimum order value on KRW markets. */
export const KRW_MIN_ORDER = 5000;
