import type { MerchantsConfig } from "./types.js";

/** Default Yandex Merchants partner API root. */
const DEFAULT_BASE = "https://yandex.ru/products/api/ext/partner";

/**
 * A missing or malformed environment variable. Thrown instead of exiting on the
 * spot so index.ts can report the drop-off before the process dies; `reason` is
 * the machine-readable code that ships with that ping (never a variable's value).
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

function die(message: string, reason: string): never {
  throw new ConfigError(message, reason);
}

/**
 * Builds the client config from environment variables, throwing ConfigError if
 * a required one is missing.
 *
 *   YANDEX_MERCHANTS_OAUTH_TOKEN  Yandex OAuth token, scope products:partner-api (required)
 *   YANDEX_MERCHANTS_BASE_URL     API root override (default https://yandex.ru/products/api/ext/partner)
 *   YANDEX_MERCHANTS_TIMEOUT_MS   per-request timeout (default 60000)
 *   YANDEX_MERCHANTS_MAX_RETRIES  retries on transient errors (default 3)
 */
export function loadConfig(): MerchantsConfig {
  const token = process.env.YANDEX_MERCHANTS_OAUTH_TOKEN;
  if (!token) {
    die(
      "YANDEX_MERCHANTS_OAUTH_TOKEN is required (Yandex OAuth token with the products:partner-api scope, obtained under the login that uploaded the feed).",
      "missing_token",
    );
  }

  const timeoutMs = Number(process.env.YANDEX_MERCHANTS_TIMEOUT_MS);
  const maxRetries = Number(process.env.YANDEX_MERCHANTS_MAX_RETRIES);

  return {
    token,
    apiBase: process.env.YANDEX_MERCHANTS_BASE_URL || DEFAULT_BASE,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
  };
}
