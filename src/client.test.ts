import { test } from "node:test";
import assert from "node:assert/strict";
import { MerchantsClient } from "./client.js";
import { CredentialsError, MISSING_CREDENTIALS_MESSAGE } from "./config.js";
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

// --- Missing credentials (degraded start) ---

/**
 * The degraded-start contract: a server without a token still runs, so the
 * client must fail the call itself — with the exact actionable message, before
 * any fetch. Zero fetch calls proves the error skips the retry/backoff loop
 * (maxRetries is deliberately non-zero here).
 */
test("no token: CredentialsError with the exact text, fetch never called", async () => {
  const mock = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    const client = new MerchantsClient({ apiBase: BASE, maxRetries: 3, retryBaseMs: 0 });
    await assert.rejects(
      () => client.feedsInfo(),
      (err: unknown) => {
        assert.ok(err instanceof CredentialsError, "must be a CredentialsError");
        assert.equal((err as Error).name, "CredentialsError");
        assert.equal((err as Error).message, MISSING_CREDENTIALS_MESSAGE);
        // The historical startup error, verbatim — the message is the product.
        assert.ok(
          (err as Error).message.startsWith(
            "YANDEX_MERCHANTS_OAUTH_TOKEN is required (Yandex OAuth token with the " +
              "products:partner-api scope, obtained under the login that uploaded the feed).",
          ),
          "the message must open with the historical startup error, verbatim",
        );
        assert.match((err as Error).message, /restart the server/, "the fix must mention the restart");
        return true;
      },
    );
    assert.equal(mock.calls.length, 0, "must not fetch at all — no retries, no backoff");
  } finally {
    mock.restore();
  }
});

test("a write without a token is rejected the same way, before fetch", async () => {
  const mock = mockFetch(() => new Response("{}", { status: 200 }));
  try {
    const client = new MerchantsClient({ apiBase: BASE, maxRetries: 3, retryBaseMs: 0 });
    await assert.rejects(
      () => client.updateOfferPrices([{ feedId: 1, offerId: "x", price: 1 }]),
      (err: unknown) => err instanceof CredentialsError,
    );
    assert.equal(mock.calls.length, 0, "fetch must not be called without credentials");
  } finally {
    mock.restore();
  }
});
