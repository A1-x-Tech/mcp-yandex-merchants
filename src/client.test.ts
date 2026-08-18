import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthRequiredError, NOT_CONNECTED_MESSAGE } from "./auth.js";
import { MerchantsClient } from "./client.js";
import { writeCredentials } from "./credentials.js";
import type { MerchantsConfig } from "./types.js";

const BASE = "https://yandex.ru/products/api/ext/partner";

type Call = { url: string; method: string; auth: unknown; body: Record<string, unknown> | undefined };

/** Installs a recording fetch stub and returns a client + the captured calls. */
function harness(extra: Partial<MerchantsConfig> = {}) {
  const calls: Call[] = [];
  const config: MerchantsConfig = {
    token: "TKN",
    apiBase: BASE,
    maxRetries: 0,
    ...extra,
  };

  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({
      url: String(url),
      method: init.method,
      auth: init.headers.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ status: "OK" }), { status: 200 });
  }) as typeof fetch;

  return { client: new MerchantsClient(config), calls, restore: () => { globalThis.fetch = orig; } };
}

test("feedsInfo: GET /feeds-info with OAuth auth and no body", async () => {
  const { client, calls, restore } = harness();
  try {
    await client.feedsInfo();
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/feeds-info`);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].auth, "OAuth TKN");
  assert.equal(calls[0].body, undefined);
});

test("updateOfferPrices maps to the wire shape and pins currencyId to RUR", async () => {
  const { client, calls, restore } = harness();
  try {
    await client.updateOfferPrices([
      {
        feedId: 1069,
        offerId: "off-1",
        price: 1490.5,
        discountBase: 1990,
        payByPrice: 1400,
        payByCondition: "yandex_pay",
      },
      { feedId: 1069, offerId: "off-2", price: 99 },
    ]);
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/offer-prices/updates`);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    offers: [
      {
        feed: { id: 1069 },
        id: "off-1",
        price: {
          currencyId: "RUR",
          value: 1490.5,
          discountBase: 1990,
          payBy: { price: 1400, condition: "yandex_pay" },
        },
      },
      {
        feed: { id: 1069 },
        id: "off-2",
        price: { currencyId: "RUR", value: 99 },
      },
    ],
  });
});

test("hideOffers: POST /hidden-offers, ttlInHours stamped onto every element", async () => {
  const { client, calls, restore } = harness();
  try {
    await client.hideOffers(
      [
        { feedId: 7, offerId: "a" },
        { feedId: 7, offerId: "b" },
      ],
      48,
    );
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/hidden-offers`);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, {
    hiddenOffers: [
      { feedId: 7, offerId: "a", ttlInHours: 48 },
      { feedId: 7, offerId: "b", ttlInHours: 48 },
    ],
  });
});

test("hideOffers without a ttl omits ttlInHours entirely", async () => {
  const { client, calls, restore } = harness();
  try {
    await client.hideOffers([{ feedId: 7, offerId: "a" }]);
  } finally {
    restore();
  }
  assert.deepEqual(calls[0].body, { hiddenOffers: [{ feedId: 7, offerId: "a" }] });
});

test("showOffers: DELETE /hidden-offers with a JSON body", async () => {
  const { client, calls, restore } = harness();
  try {
    await client.showOffers([{ feedId: 7, offerId: "a" }]);
  } finally {
    restore();
  }
  assert.equal(calls[0].url, `${BASE}/hidden-offers`);
  assert.equal(calls[0].method, "DELETE");
  assert.deepEqual(calls[0].body, { hiddenOffers: [{ feedId: 7, offerId: "a" }] });
});

test("non-2xx throws MerchantsError with the status and the errors[] codes", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ status: "ERROR", errors: [{ code: "INVALID_FEED_ID", message: "unknown feed" }] }),
      { status: 400 },
    )) as typeof fetch;
  const client = new MerchantsClient({ token: "T", apiBase: BASE, maxRetries: 0 });
  try {
    await assert.rejects(
      () => client.updateOfferPrices([{ feedId: 1, offerId: "x", price: 1 }]),
      /HTTP 400: \[INVALID_FEED_ID\] unknown feed/,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

// --- Retry / timeout / SSRF behavior ---

function makeClient(overrides: Partial<MerchantsConfig> = {}) {
  return new MerchantsClient({
    token: "T",
    apiBase: BASE,
    retryBaseMs: 0, // no real backoff delay in tests
    ...overrides,
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as RequestInit;
    calls.push({ url: String(url), init: i });
    return handler(String(url), i);
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test("request() retries a 429 rate limit even for writes", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ status: "OK" }), { status: 200 });
  });
  try {
    const result = await makeClient().updateOfferPrices([{ feedId: 1, offerId: "x", price: 1 }]);
    assert.deepEqual(result, { status: "OK" });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("request() retries a 5xx for GET (feeds-info) then returns the result", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ status: "OK", feeds: [] }), { status: 200 });
  });
  try {
    const result = await makeClient().feedsInfo();
    assert.deepEqual(result, { status: "OK", feeds: [] });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("request() does NOT retry a 5xx for a write (a 502 after commit would duplicate it)", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response("bad gateway", { status: 502 });
  });
  try {
    await assert.rejects(
      () => makeClient({ maxRetries: 3 }).updateOfferPrices([{ feedId: 1, offerId: "x", price: 1 }]),
      /HTTP 502/,
    );
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }
});

test("request() does not retry a 400 and gives up after maxRetries on 429", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    return new Response("nope", { status: 400 });
  });
  try {
    await assert.rejects(() => makeClient().feedsInfo(), /HTTP 400/);
    assert.equal(calls, 1);
  } finally {
    mock.restore();
  }

  calls = 0;
  const mock2 = mockFetch(() => {
    calls++;
    return new Response("slow down", { status: 429 });
  });
  try {
    await assert.rejects(() => makeClient({ maxRetries: 2 }).feedsInfo(), /HTTP 429/);
    assert.equal(calls, 3); // initial + 2 retries
  } finally {
    mock2.restore();
  }
});

test("request() retries a network error for GET then succeeds", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    if (calls === 1) throw new Error("ECONNRESET");
    return new Response(JSON.stringify({ status: "OK" }), { status: 200 });
  });
  try {
    const result = await makeClient({ maxRetries: 2 }).feedsInfo();
    assert.deepEqual(result, { status: "OK" });
    assert.equal(calls, 2);
  } finally {
    mock.restore();
  }
});

test("request() rethrows a network error immediately for a write", async () => {
  let calls = 0;
  const mock = mockFetch(() => {
    calls++;
    throw new Error("ECONNRESET");
  });
  try {
    await assert.rejects(
      () => makeClient({ maxRetries: 3 }).showOffers([{ feedId: 1, offerId: "x" }]),
      /ECONNRESET/,
    );
    assert.equal(calls, 1); // no retry: the write may have committed
  } finally {
    mock.restore();
  }
});

test("request() aborts and reports a timeout when the request hangs", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init: unknown) =>
    new Promise((_resolve, reject) => {
      const signal = (init as RequestInit).signal as AbortSignal;
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    })) as typeof fetch;
  try {
    const client = makeClient({ timeoutMs: 10, maxRetries: 0 });
    await assert.rejects(() => client.feedsInfo(), /timed out after 10ms/);
  } finally {
    globalThis.fetch = original;
  }
});

test("request() rejects an absolute path (SSRF) and never fetches a foreign origin", async () => {
  for (const evil of ["https://evil.example/steal", "http://evil.example/x", "\\\\evil.example/x"]) {
    const mock = mockFetch(() => new Response("{}", { status: 200 }));
    try {
      await assert.rejects(() => makeClient().request("GET", evil), /foreign origin/);
      assert.equal(mock.calls.length, 0, `must not fetch for ${JSON.stringify(evil)}`);
    } finally {
      mock.restore();
    }
  }
});

test("request() still accepts a relative API path", async () => {
  const mock = mockFetch(() => new Response(JSON.stringify({ status: "OK" }), { status: 200 }));
  try {
    const result = await makeClient().request("GET", "feeds-info");
    assert.deepEqual(result, { status: "OK" });
    assert.equal(mock.calls[0].url, `${BASE}/feeds-info`);
  } finally {
    mock.restore();
  }
});

test("a same-origin base override keeps paths relative to it", async () => {
  const mock = mockFetch(() => new Response(JSON.stringify({ status: "OK" }), { status: 200 }));
  try {
    await makeClient({ apiBase: "http://127.0.0.1:8080/mock" }).feedsInfo();
    assert.equal(mock.calls[0].url, "http://127.0.0.1:8080/mock/feeds-info");
  } finally {
    mock.restore();
  }
});

// --- Missing credentials (degraded start) & the in-chat login ---

/** Points XDG_CONFIG_HOME at a fresh temp dir so the developer's own stored login never leaks in. */
function withTempConfigDir(): { dir: string; restore: () => void } {
  const saved = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), "mcp-merchants-client-"));
  process.env.XDG_CONFIG_HOME = dir;
  return {
    dir,
    restore() {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    },
  };
}

/**
 * The degraded-start contract: a server without a token still runs, so the
 * client must fail the call itself — with the exact actionable message, before
 * any fetch. Zero fetch calls proves the error skips the retry/backoff loop
 * (maxRetries is deliberately non-zero here), and the timing assertion proves
 * it was not treated as transport trouble.
 */
test("no token anywhere: AuthRequiredError with the exact text, fetch never called", async () => {
  const tempConfig = withTempConfigDir();
  const mock = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    const client = new MerchantsClient({ apiBase: BASE, maxRetries: 5, retryBaseMs: 1000 });
    const started = Date.now();
    await assert.rejects(
      () => client.feedsInfo(),
      (err: unknown) => {
        assert.ok(err instanceof AuthRequiredError, "must be an AuthRequiredError");
        assert.equal((err as Error).name, "AuthRequiredError");
        // The message is the product: pinned verbatim, with both fixes in it.
        assert.equal((err as Error).message, NOT_CONNECTED_MESSAGE);
        assert.match((err as Error).message, /start_login/, "the in-chat fix must be named");
        assert.match(
          (err as Error).message,
          /YANDEX_MERCHANTS_OAUTH_TOKEN/,
          "the env fix must be named too",
        );
        return true;
      },
    );
    assert.ok(Date.now() - started < 500, "the answer must be immediate, not backed off");
    assert.equal(mock.calls.length, 0, "must not fetch at all — no retries, no backoff");
  } finally {
    mock.restore();
    tempConfig.restore();
  }
});

test("a write without a token is rejected the same way, before fetch", async () => {
  const tempConfig = withTempConfigDir();
  const mock = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    const client = new MerchantsClient({ apiBase: BASE, maxRetries: 3, retryBaseMs: 0 });
    await assert.rejects(
      () => client.updateOfferPrices([{ feedId: 1, offerId: "x", price: 1 }]),
      (err: unknown) => err instanceof AuthRequiredError,
    );
    assert.equal(mock.calls.length, 0, "fetch must not be called without credentials");
  } finally {
    mock.restore();
    tempConfig.restore();
  }
});

/**
 * The property the whole flow exists for: `finish_login` writes credentials to
 * disk mid-session, and the very next call on the SAME client instance must pick
 * them up — no new client, no restart. That only holds while the token is
 * resolved per request, never cached on the instance.
 */
test("a login mid-session takes effect on the next call of the same client", async () => {
  const tempConfig = withTempConfigDir();
  const mock = mockFetch(() => new Response(JSON.stringify({ status: "OK", feeds: [] }), { status: 200 }));
  try {
    const client = new MerchantsClient({ apiBase: BASE, maxRetries: 0 });
    await assert.rejects(() => client.feedsInfo(), AuthRequiredError);
    assert.equal(mock.calls.length, 0);

    // What finish_login does under the hood: persist the minted token.
    writeCredentials({ access_token: "fresh-login", obtained_at: Date.now() });

    const result = await client.feedsInfo();
    assert.deepEqual(result, { status: "OK", feeds: [] });
    const headers = mock.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "OAuth fresh-login", "the stored token must be used at once");
  } finally {
    mock.restore();
    tempConfig.restore();
  }
});

test("an env token wins over a stored login for every request", async () => {
  const tempConfig = withTempConfigDir();
  const mock = mockFetch(() => new Response(JSON.stringify({ status: "OK" }), { status: 200 }));
  try {
    writeCredentials({ access_token: "stored", obtained_at: Date.now() });
    const client = new MerchantsClient({ token: "from-env", apiBase: BASE, maxRetries: 0 });
    await client.feedsInfo();
    const headers = mock.calls[0].init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "OAuth from-env");
  } finally {
    mock.restore();
    tempConfig.restore();
  }
});

/**
 * A stored token can be revoked in Yandex ID long before its stated expiry, and
 * only the API knows: a 401 gets one silent re-mint + replay. 403 deliberately
 * does not — for this API it means a wrong login or rights not yet confirmed in
 * Webmaster, which a fresh token of the same login cannot fix.
 */
test("a 401 on a stored token is refreshed once and the request is replayed", async () => {
  const tempConfig = withTempConfigDir();
  writeCredentials({ access_token: "revoked", refresh_token: "rt", obtained_at: Date.now() });
  const apiCalls: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.startsWith("https://oauth.yandex.ru/token")) {
      return new Response(
        JSON.stringify({ access_token: "reborn", refresh_token: "rt2", expires_in: 3600 }),
        { status: 200 },
      );
    }
    apiCalls.push((init.headers as Record<string, string>).Authorization);
    if (apiCalls.length === 1) return new Response("unauthorized", { status: 401 });
    return new Response(JSON.stringify({ status: "OK", feeds: [] }), { status: 200 });
  });
  try {
    const client = new MerchantsClient({ apiBase: BASE, maxRetries: 0 });
    const result = await client.feedsInfo();
    assert.deepEqual(result, { status: "OK", feeds: [] });
    assert.deepEqual(apiCalls, ["OAuth revoked", "OAuth reborn"], "one replay with the re-minted token");
  } finally {
    mock.restore();
    tempConfig.restore();
  }
});
