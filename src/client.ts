import { AuthRequiredError, TokenStore } from "./auth.js";
import type { MerchantsConfig, PayByCondition } from "./types.js";
import { MerchantsError } from "./types.js";

export type HttpMethod = "GET" | "POST" | "DELETE";

/** Normalized price update for one offer; the client builds the wire shape. */
export interface OfferPriceUpdate {
  /** Feed id (feedId from feeds-info). */
  feedId: number;
  /** Offer id from the feed (≤ 50 chars). */
  offerId: string;
  /** New price (> 0). Currency is always RUR — the API accepts nothing else. */
  price: number;
  /** Pre-discount price shown struck through; must be above `price` (5–95% discount). */
  discountBase?: number;
  /** Special price applied when the payment condition is met. */
  payByPrice?: number;
  /** Payment condition for `payByPrice`. */
  payByCondition?: PayByCondition;
}

/** A reference to one offer inside a feed (hide/show operations). */
export interface OfferRef {
  feedId: number;
  offerId: string;
}

export class MerchantsClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  private readonly tokens: TokenStore;

  constructor(
    private readonly config: MerchantsConfig,
    tokens?: TokenStore,
  ) {
    this.base = config.apiBase.endsWith("/") ? config.apiBase : config.apiBase + "/";
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseMs = config.retryBaseMs ?? 500;
    // Default store keeps the old contract for callers that pass a plain config
    // (tests, smoke): config.token wins, stored credentials are the fallback.
    this.tokens = tokens ?? new TokenStore(config.token);
  }

  /**
   * Resolved per request, never cached on the instance: `finish_login` writes a
   * new token to disk mid-session and the very next call has to pick it up.
   */
  private async headers(hasBody: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      Authorization: `OAuth ${await this.tokens.getToken()}`,
    };
    if (hasBody) h["Content-Type"] = "application/json";
    return h;
  }

  /** Backoff before a retry: honors Retry-After when present, else exponential (capped at 30s). */
  private backoffMs(attempt: number, res?: Response): number {
    const retryAfter = res ? Number(res.headers.get("Retry-After")) : NaN;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
    return Math.min(this.retryBaseMs * 2 ** attempt, 30_000);
  }

  /**
   * fetch with an AbortController timeout. Reads the response body inside the
   * guarded zone so the timeout also covers a slow or drip-feeding body, not just
   * the initial headers, and returns the text alongside the response.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    label: string,
  ): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request to "${label}" timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Low-level request to a Merchants partner API path (e.g. "feeds-info").
   * The token is resolved per request via {@link TokenStore}; with no token
   * available anywhere it throws {@link AuthRequiredError} BEFORE any fetch —
   * a missing setup must never enter the retry/backoff loop, because no amount
   * of retrying mints credentials. Retries 429 always; 5xx and network
   * errors/timeouts only for GET — this is a write API, and a 502 after a
   * POST/DELETE commits could duplicate the write. Any other non-2xx throws a
   * {@link MerchantsError}.
   */
  async request<T = unknown>(method: HttpMethod, path: string, body?: Record<string, unknown>): Promise<T> {
    // Guard method !== "GET" keeps undici from crashing on a GET-with-body.
    const hasBody = body !== undefined && method !== "GET";

    // Resolve the path against the API base, then reject anything that escaped to a
    // foreign origin (an absolute "https://evil/x" or a "\\evil/x" slipped through
    // raw_request) so the OAuth token can never leak to another host.
    const url = new URL(path.replace(/^\//, ""), this.base);
    if (url.origin !== new URL(this.base).origin) {
      throw new Error(`raw_request path must be a relative API path (resolved to foreign origin ${url.origin})`);
    }
    const target = url.toString();

    // Only GET (feeds-info) is safe to replay after an ambiguous failure. The
    // write endpoints happen to be state-setting (same price / same hide), but
    // the API does not document dedup, so 5xx/network retries stay gated.
    const idempotent = method === "GET";
    // A stored token can be revoked (or die early) long before its stated expiry,
    // and only the API knows: one silent re-mint + replay per request, then give up.
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        ({ res, text } = await this.fetchWithTimeout(
          target,
          {
            method,
            headers: await this.headers(hasBody),
            body: hasBody ? JSON.stringify(body) : undefined,
          },
          path,
        ));
      } catch (err) {
        // "Not connected" is raised while building the auth header, inside this
        // try — but it is not transport trouble: retrying burns the full backoff
        // (seconds) before the user sees the one message that would help them,
        // and fetch must never fire without auth (pinned in client.test.ts).
        if (err instanceof AuthRequiredError) throw err;
        // Network error or timeout: retry idempotent requests with backoff; on the
        // last attempt (or a non-idempotent method) rethrow the original error.
        if (idempotent && attempt < this.maxRetries) {
          await delay(this.backoffMs(attempt));
          continue;
        }
        throw err;
      }

      const transient = res.status === 429 || (idempotent && res.status >= 500 && res.status < 600);
      if (transient && attempt < this.maxRetries) {
        await delay(this.backoffMs(attempt, res));
        continue;
      }

      let data: unknown = undefined;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      // 401 is the one failure a re-mint can fix (revoked/expired stored token).
      // A 403 stays out on purpose: here it means a wrong login or rights not
      // yet confirmed in Webmaster — a fresh token of the same login changes
      // nothing. The retry budget above is for transport trouble, not this.
      if (!res.ok && !refreshed && res.status === 401 && this.tokens.canRefresh()) {
        refreshed = true;
        try {
          await this.tokens.refresh();
          attempt--;
          continue;
        } catch (err) {
          // Refresh itself failed (revoked in Yandex ID, network down): surface the
          // actionable message instead of the original 401.
          if (err instanceof AuthRequiredError) throw err;
          throw new AuthRequiredError(
            `Не удалось обновить токен Яндекс Товаров: ${err instanceof Error ? err.message : String(err)}. ` +
              "Вызовите start_login и подключитесь заново.",
          );
        }
      }

      if (!res.ok) throw new MerchantsError(res.status, data);
      return data as T;
    }
  }

  /** Feeds available to the token's login: [{ feedId, feedUrl }]. */
  async feedsInfo(): Promise<unknown> {
    return this.request("GET", "feeds-info");
  }

  /** Updates prices for 1..2000 offers in one call (currency always RUR). */
  async updateOfferPrices(offers: OfferPriceUpdate[]): Promise<unknown> {
    return this.request("POST", "offer-prices/updates", {
      offers: offers.map((o) => mapOfferPrice(o)),
    });
  }

  /** Hides 1..500 offers from search; optional ttlInHours (≤ 720) applies to each. */
  async hideOffers(offers: OfferRef[], ttlInHours?: number): Promise<unknown> {
    return this.request("POST", "hidden-offers", {
      hiddenOffers: offers.map((o) =>
        compact({ feedId: o.feedId, offerId: o.offerId, ttlInHours }),
      ),
    });
  }

  /** Unhides 1..500 previously hidden offers (DELETE with a JSON body). */
  async showOffers(offers: OfferRef[]): Promise<unknown> {
    return this.request("DELETE", "hidden-offers", {
      hiddenOffers: offers.map((o) => ({ feedId: o.feedId, offerId: o.offerId })),
    });
  }
}

/**
 * Maps a normalized price update to the API's wire shape:
 * { feed: { id }, id, price: { currencyId: "RUR", value, discountBase?, payBy? } }.
 * currencyId is pinned to RUR — the only value the API accepts.
 */
function mapOfferPrice(o: OfferPriceUpdate): Record<string, unknown> {
  const payBy =
    o.payByPrice !== undefined || o.payByCondition !== undefined
      ? compact({ price: o.payByPrice, condition: o.payByCondition })
      : undefined;
  return {
    feed: { id: o.feedId },
    id: o.offerId,
    price: compact({
      currencyId: "RUR",
      value: o.price,
      discountBase: o.discountBase,
      payBy,
    }),
  };
}

/** Drops keys whose value is `undefined` so they are not sent to the API. */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
