import type { MerchantsConfig } from "./types.js";

/** Default Yandex Merchants partner API root. */
export const DEFAULT_BASE = "https://yandex.ru/products/api/ext/partner";

/**
 * A malformed environment variable. Thrown instead of exiting on the spot so
 * index.ts can catch it, report the drop-off and start degraded instead of
 * dying; `reason` is the machine-readable code that ships with that ping (never
 * a variable's value). A *missing* variable is NOT a ConfigError — see
 * loadConfig. (Today loadConfig has no malformed-value checks, so nothing
 * throws this; the class stays for future ones.)
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/**
 * Builds the client config from environment variables.
 *
 * A missing token is NOT an error here: the server starts anyway and the token
 * is resolved per request (env → stored credentials), so an unconfigured
 * install can log in from the chat (`start_login` → `finish_login`) instead of
 * dying before the MCP handshake. When neither source has a token, the client
 * raises `AuthRequiredError` (src/auth.ts) at call time — its message carries
 * both fixes: the in-chat login and the env var.
 *
 *   YANDEX_MERCHANTS_OAUTH_TOKEN  Yandex OAuth token, scope products:partner-api (optional; wins over the stored login)
 *   YANDEX_MERCHANTS_BASE_URL     API root override (default https://yandex.ru/products/api/ext/partner)
 *   YANDEX_MERCHANTS_TIMEOUT_MS   per-request timeout (default 60000)
 *   YANDEX_MERCHANTS_MAX_RETRIES  retries on transient errors (default 3)
 */
export function loadConfig(): MerchantsConfig {
  const timeoutMs = Number(process.env.YANDEX_MERCHANTS_TIMEOUT_MS);
  const maxRetries = Number(process.env.YANDEX_MERCHANTS_MAX_RETRIES);

  return {
    // An empty string reads as absent, never as an empty credential.
    token: process.env.YANDEX_MERCHANTS_OAUTH_TOKEN || undefined,
    apiBase: process.env.YANDEX_MERCHANTS_BASE_URL || DEFAULT_BASE,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
  };
}
