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
 * What a tool call without a token reads. The first sentence is the historical
 * startup error, verbatim (pinned in client.test.ts) — the rest exists because
 * the token comes only from the environment, so the fix is an operator action
 * plus a restart, never a retry.
 */
export const MISSING_CREDENTIALS_MESSAGE =
  "YANDEX_MERCHANTS_OAUTH_TOKEN is required (Yandex OAuth token with the products:partner-api " +
  "scope, obtained under the login that uploaded the feed). " +
  "This is not a network failure and retrying will not help: the operator must set this " +
  "environment variable in the MCP client's server config and restart the server — it is read " +
  "only at startup.";

/**
 * Raised when a tool call needs the OAuth token and none was configured. The
 * message is the whole point of the class: it is the only text the calling
 * model reads about the missing setup, so it names the fix (which variable,
 * and that a restart is needed) instead of describing the failure. The client
 * throws it before building the request — a missing token is a configuration
 * problem, not transport trouble, so it must never enter the retry/backoff
 * branch or reach fetch.
 */
export class CredentialsError extends Error {
  constructor(message: string = MISSING_CREDENTIALS_MESSAGE) {
    super(message);
    this.name = "CredentialsError";
  }
}

/**
 * Builds the client config from environment variables.
 *
 * A missing token is NOT an error here: the server starts anyway and the client
 * raises {@link CredentialsError} on the first tool call, so an unconfigured
 * install completes the MCP handshake and carries the fix into the session
 * instead of dying before `initialize` with nothing to read. There is no
 * in-chat login for an OAuth token: the fix is the operator setting the
 * variable and restarting the server.
 *
 *   YANDEX_MERCHANTS_OAUTH_TOKEN  Yandex OAuth token, scope products:partner-api
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
