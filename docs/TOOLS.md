# Tools

For task-oriented guidance, open the [MCP capability catalog](./capabilities/index.md). This page remains the technical reference for schemas and API responses.

This is a **write API**: besides the feeds-info wrappers and the local
connection tools every tool mutates state (prices, hidden offers). Inputs are normalized snake_case (`feed_id`, `offer_id`,
`ttl_in_hours`); the client maps them to the API's wire shape
(`{ feed: { id }, id, price: { currencyId: "RUR", value, ... } }`,
`{ hiddenOffers: [{ feedId, offerId, ttlInHours }] }`) and pins `currencyId` to
`RUR` — the only currency the API accepts.

## Connection & login

| Tool | Description |
|---|---|
| `auth_status` | Whether a token is available, where it came from (`env` = `YANDEX_MERCHANTS_OAUTH_TOKEN`, `stored` = the in-chat login), when the stored token expires and where the credentials file lives. Local only — no network, and the token itself is never shown. |
| `start_login` | First step of the in-chat login: returns a Yandex OAuth authorize URL (PKCE S256, `scope=products:partner-api`, no `client_secret` — public client). Show the URL to the user; they must open it **under the login that uploaded the YML feed** and bring back the confirmation code (valid 10 minutes, one-shot). |
| `finish_login` | Second step: exchanges the confirmation code for tokens, stores them in `~/.config/mcp-yandex-merchants/credentials.json` (mode `0600`) and verifies with a live `GET /feeds-info`. `feedsVisible: 0` almost always means a wrong-login token. Takes effect immediately — no client restart. |
| `logout` | Deletes the stored credentials file. Never touches `YANDEX_MERCHANTS_OAUTH_TOKEN`; the app grant itself stays active until revoked in Yandex ID. |

The token is resolved per request: `YANDEX_MERCHANTS_OAUTH_TOKEN` wins when set,
otherwise the stored login is used (and refreshed on expiry / after a 401).
With neither source, data tools answer with an `AuthRequiredError` message that
names both fixes.

## Feeds & diagnostics (read-only)

| Tool | Description |
|---|---|
| `list_feeds` | Feeds available to the token's login: `{ status, feeds: [{ feedId, feedUrl }] }`. The `feedId` here feeds the `feed_id` parameter of every other tool. The API returns nothing else about feeds — no status, no offer list; feeds are created/deleted only in the cabinet or Webmaster. |
| `check_access` | Connection diagnostics: performs the same `GET /feeds-info` and answers `{ ok, feedsCount }` or `{ ok: false, error }` (as data, not an error result). There is no dedicated ping endpoint in the API. |

## Prices

| Tool | Description |
|---|---|
| `set_offer_price` | Updates the price of a single offer (`POST /offer-prices/updates` with one element). Optional `discount_base` (struck-through pre-discount price, 5–95% discount enforced by the API) and `pay_by_price` + `pay_by_condition` (`yandex_pay` / `fast_payment_system` / `ozon_card`; the pair is all-or-nothing — the wire `payBy` is `{ price, condition }`). If the feed has several offers with the same id, only the first one is updated. |
| `update_offer_prices` | Bulk price update: 1–2000 offers per request. Error codes: `DUPLICATE_OFFER`, `INVALID_FEED_ID`, `INVALID_OFFER_ID`, `LIMIT_EXCEEDED`, `REQUEST_LIMIT_EXCEEDED` (> 2000 per request). Rate limit: 50 000 price changes per minute. |
| `set_offer_discount` | Sets a discount: `price` (discounted) + mandatory `discount_base` (old, struck-through). The 5–95% window is validated MCP-side before the request (the API would answer 400 otherwise). |

## Hiding & showing offers

| Tool | Description |
|---|---|
| `hide_offer` | Hides one offer from search (`POST /hidden-offers`), e.g. when it is out of stock. Optional `ttl_in_hours` ≤ 720 (30 days; `INVALID_TTL` otherwise); what a repeat hide with a new TTL does is undocumented (treated as non-idempotent here). Without a TTL the offer stays hidden until `show_offers`. |
| `hide_offers` | Bulk hide: 1–500 offers per request, one shared `ttl_in_hours`. Error codes: `DUPLICATE_OFFER`, `INVALID_FEED_ID`, `INVALID_OFFER_ID`, `INVALID_TTL`, `LIMIT_EXCEEDED`, `REQUEST_LIMIT_EXCEEDED` (> 500 per request). |
| `show_offers` | Unhides 1–500 previously hidden offers (`DELETE /hidden-offers` with a JSON body). |

Rate limit for hide + show combined: 50 000 operations per minute.

Notes:

- **Check `status` in responses.** Write endpoints answer `{ "status": "OK" }` or
  `{ "status": "ERROR", "errors": [{ "code", "message" }] }` — an HTTP 200 alone is
  not success.
- **RUR only.** The client pins `currencyId: "RUR"`; there is no way to manage
  prices in other currencies.
- **No state reads.** The API cannot list hidden offers, current prices or feed
  contents — track what you changed on your side.
- **`ttlInHours` serialization** is confirmed only by the `INVALID_TTL` error text
  in the docs (the parameter table omits it) — verify against the live API if
  hides-with-TTL misbehave.

## Escape hatch

| Tool | Description |
|---|---|
| `raw_request` | Call any Merchants partner API path directly (e.g. `feeds-info`, `offer-prices/updates`, `hidden-offers`) with `GET`/`POST`/`DELETE` for endpoints without a dedicated tool. `body` is sent as JSON in the API's wire format, untouched. A `path` that resolves to a foreign origin is rejected (SSRF guard), so the OAuth token can never leak to another host. |

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `YANDEX_MERCHANTS_OAUTH_TOKEN` | no | — | Yandex OAuth token with the `products:partner-api` scope, obtained under the login that uploaded the feed. Optional since the in-chat login exists; when set it wins over the stored login and is never refreshed or deleted by the server. Treat it as a secret. |
| `YANDEX_MERCHANTS_OAUTH_CLIENT_ID` | no | the A1 public client | ClientID of your own OAuth app for the in-chat login (Redirect URI must be `https://oauth.yandex.ru/verification_code`). |
| `YANDEX_MERCHANTS_BASE_URL` | no | `https://yandex.ru/products/api/ext/partner` | API root override. |
| `YANDEX_MERCHANTS_TIMEOUT_MS` | no | `60000` | Per-request timeout, ms. |
| `YANDEX_MERCHANTS_MAX_RETRIES` | no | `3` | Retries: 429 always; 5xx/network for GET only (writes are never replayed). |
