/**
 * The server talks to the Yandex Merchants (Яндекс Товары) partner API —
 * «API поиска по товарам» (https://yandex.ru/products/api/ext/partner). Auth is
 * a Yandex OAuth token with the `products:partner-api` scope, sent as
 * `Authorization: OAuth <token>`. The API is tiny: 4 endpoints (feeds info,
 * price updates, hiding offers, unhiding offers); prices are RUR-only.
 */

/**
 * Payment condition for a special "pay-by" price, normalized; passed to the API
 * verbatim (the wire values are already snake_case).
 */
export type PayByCondition = "yandex_pay" | "fast_payment_system" | "ozon_card";

export interface MerchantsConfig {
  /**
   * Yandex OAuth token (scope products:partner-api), sent as `OAuth`. Treated
   * as a secret. Absent when YANDEX_MERCHANTS_OAUTH_TOKEN is not set — the
   * server still starts (degraded) and the client raises `CredentialsError`
   * at call time instead.
   */
  token?: string;
  /** API root URL. Defaults to https://yandex.ru/products/api/ext/partner. */
  apiBase: string;
  /** Per-request timeout in milliseconds. Defaults to 60_000. */
  timeoutMs?: number;
  /** Max retries for transient errors (429 always; 5xx/network for GET only). Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in milliseconds, doubled each retry. Defaults to 500. */
  retryBaseMs?: number;
}

/**
 * The Merchants API reports failures as a non-2xx HTTP status with a JSON body
 * ({ status: "ERROR", errors: [{ code, message }] }). The parsed body is kept
 * alongside the status and a short readable message is derived.
 */
export class MerchantsError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}: ${formatErrorBody(body)}`);
    this.name = "MerchantsError";
    this.status = status;
    this.body = body;
  }
}

/** Turns a parsed Merchants API error body into a short, readable message. */
function formatErrorBody(body: unknown): string {
  if (body == null) return "(no body)";
  if (typeof body === "string") return body.slice(0, 500);
  if (typeof body !== "object") return String(body);
  const obj = body as Record<string, unknown>;

  // Merchants API style: { status: "ERROR", errors: [{ code, message }] }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const parts = obj.errors.map((e) => {
      if (e && typeof e === "object") {
        const err = e as Record<string, unknown>;
        const code = err.code !== undefined ? `[${String(err.code)}] ` : "";
        const message = typeof err.message === "string" ? err.message : JSON.stringify(err);
        return `${code}${message}`;
      }
      return String(e);
    });
    return parts.join("; ").slice(0, 500);
  }

  if (typeof obj.message === "string") {
    const code = obj.code !== undefined ? `[${String(obj.code)}] ` : "";
    return `${code}${obj.message}`.slice(0, 500);
  }

  return JSON.stringify(obj).slice(0, 500);
}
