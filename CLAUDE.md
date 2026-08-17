# CLAUDE.md — mcp-yandex-merchants

MCP server for the Yandex Merchants (Яндекс Товары) partner API (TypeScript,
stdio). This is a **write API**: tools wrap the 4 documented endpoints — feeds
info (`GET /feeds-info`), price updates (`POST /offer-prices/updates`), hiding
(`POST /hidden-offers`) and unhiding (`DELETE /hidden-offers`);
`raw_request` is the escape hatch. The server talks to
`https://yandex.ru/products/api/ext/partner`; auth is a Yandex OAuth token with
the `products:partner-api` scope, sent as `Authorization: OAuth <token>` — the
token must belong to the login that uploaded the YML feed.

## Commands

```bash
npm run dev        # run from source (tsx watch)
npm test           # unit tests, no network
npm run typecheck  # types for src + tests
npm run build      # emit dist/
npm run smoke      # live READ-ONLY call (needs YANDEX_MERCHANTS_OAUTH_TOKEN)
```

## Architecture

- `src/config.ts` — env → config; throws `ConfigError` (with a `reason` code) instead of
  exiting, so `index.ts` can report the drop-off before dying.
  Requires `YANDEX_MERCHANTS_OAUTH_TOKEN`; optional `YANDEX_MERCHANTS_BASE_URL`,
  `YANDEX_MERCHANTS_TIMEOUT_MS`, `YANDEX_MERCHANTS_MAX_RETRIES`.
- `src/client.ts` — maps each logical call (`feedsInfo`/`updateOfferPrices`/`hideOffers`/
  `showOffers`) to its endpoint: `OAuth` auth, the price wire shape
  (`{ feed: { id }, id, price: { currencyId: "RUR", value, discountBase?, payBy? } }`),
  `hiddenOffers` with `ttlInHours` stamped onto every element. `request()` resolves the
  path against the base and rejects any path that escapes to a foreign origin (SSRF
  guard), retries 429 always but 5xx/network **only for GET** (a 502 after a write
  commits could duplicate it), enforces an AbortController timeout that also covers
  reading the body, and throws `MerchantsError(status, body)`.
- `src/tools/feeds.ts` — `list_feeds`, `check_access` (diagnostics: failures come back
  as `{ ok: false, error }` data, not `isError`). `src/tools/prices.ts` —
  `set_offer_price`, `update_offer_prices`, `set_offer_discount` (validates the 5–95%
  window before the request). `src/tools/hidden.ts` — `hide_offer`, `hide_offers`,
  `show_offers`. `src/tools/raw.ts` — `raw_request` (GET/POST/DELETE, not read-only).
  `src/tools/util.ts` — `ok`/`fail`/`errorMessage`, the `READ_ONLY`/`WRITE`/
  `WRITE_IDEMPOTENT` annotations and shared zod schema factories (`feedId`, `offerId`,
  `price`, `ttlInHours`, `payByCondition`).
- `src/index.ts` — wires every `register*` into the McpServer.
- `src/telemetry.ts` — anonymous usage pings (ids/names/versions only, never data or
  arguments; fire-and-forget, must never block or throw; opt-out `ASKADS_TELEMETRY=0`).
  `startup_failed` is the exception: `sendBlocking` awaits it, because the caller
  exits right after and a fire-and-forget ping would die in flight. Its `reason`
  is a closed vocabulary (`missing_token`) — never a variable's name or value.

## Conventions (do not break)

- **This is a write API — annotate honestly.** Only the feeds-info wrappers are
  `READ_ONLY`; price/unhide tools are `WRITE_IDEMPOTENT`, hides and `raw_request` are
  `WRITE`. `annotations.test.ts` pins the full tool → hints map.
- **Never retry writes on 5xx/network.** `request()` gates those retries to GET; only
  429 is retried for every method. Don't loosen this: the API does not document dedup.
- **Wire mapping lives in the client, not the tools.** Tools accept normalized snake_case
  inputs (`feed_id`, `offer_id`, `ttl_in_hours`) and must not know the wire shape — add
  any mapping in `client.ts` (`mapOfferPrice` and the per-method body builders).
- **`currencyId: "RUR"` is the client's job.** It is pinned in `mapOfferPrice`; tools
  never pass a currency (the API accepts nothing else).
- **Validate inputs with zod** in `inputSchema` (offer ids ≤ 50 chars, batches ≤ 2000 /
  ≤ 500, ttl ≤ 720). Reuse the shared schema **factories** in `util.ts` (a fresh schema
  per field avoids `$ref` dedup in the JSON schema). Cross-field checks that zod can't
  express (the 5–95% discount window, the `pay_by_price` + `pay_by_condition` pair)
  live at the top of the handler and fail fast.
- **Output compact JSON via `ok`** — the consumer is an LLM; pretty-printing burns tokens.
  Responses pass through verbatim (describe the fields in the tool `description`, the only
  place the external model reads).
- **HTTP 200 is not success.** Write endpoints answer `{ status: "OK" | "ERROR", errors? }`;
  tool descriptions must keep telling the model to check `status`.
- **`ttlInHours` serialization is unverified** against the live API (the docs confirm it
  only via the `INVALID_TTL` error text) — if hides-with-TTL misbehave, check the wire
  name first.

## Adding a tool

Before changing the tool registry, read [the MCP capability documentation contract](docs/CAPABILITY-DOCUMENTATION.md). Every registered tool must have exactly one task-oriented page in `docs/capabilities/`; update that page, the index, and the coverage test in the same change.

1. Add (or extend) `src/tools/<name>.ts` with `register<Name>Tools(server, client)`.
2. If it hits a new endpoint, add a method to `src/client.ts` with the wire mapping.
3. Import and call the register fn in `src/index.ts`.
4. Add a `*.test.ts` using the mock-fetch (client) / fake-client (tools) harness — no
   network — and extend the pinned maps in `annotations.test.ts` and
   `test/dist-smoke.test.js`.
5. `npm run typecheck && npm test`.

## Releasing

Keep the version in sync across **all** channels in one go — publishing to npm alone silently
drifts from the rest (`git push --follow-tags` pushes the tag but does **not** create a GitHub
Release; the registry is immutable per version, so even a metadata-only change needs a bump):

1. Bump `version` in **three places, identically**: `package.json`, and in `server.json`
   **both** the root `version` **and** `packages[0].version`. `mcpName` in `package.json` must
   match `name` in `server.json`. Verify before publishing — all three must print the same X.Y.Z:
   `grep -n '"version"' package.json server.json`.
   > ⚠️ `mcp-publisher` publishes the **root** `server.json.version`. If you bump npm +
   > `packages[0].version` but leave the root stale, `npm publish` still succeeds (it reads
   > `package.json`), yet `mcp-publisher publish` fails with a misleading
   > `400 cannot publish duplicate version` — it is re-publishing the old root version.
2. `npm publish` (runs typecheck + tests + build via `prepublishOnly` / `prepare`).
3. `git commit`, `git tag -a vX.Y.Z -m vX.Y.Z`, `git push origin main --follow-tags`.
4. **GitHub Release:** `gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag`.
5. **Official MCP registry:** `mcp-publisher publish`.
