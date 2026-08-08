# Development

## Requirements

- Node.js 20+ (the published package ships compiled `dist/`; `npx` needs no separate
  install). CI runs the suite on Node 20, 22 and 24.

## Commands

```bash
npm install
npm run dev        # run from source with tsx watch
npm test           # unit tests (node:test), no network
npm run typecheck  # type-check src + tests (no emit)
npm run build      # clean dist/ and compile with tsc
npm run smoke      # live READ-ONLY call: lists the feeds available to the token
```

## Local run

```bash
npm run build
YANDEX_MERCHANTS_OAUTH_TOKEN=... node dist/index.js
# optional: YANDEX_MERCHANTS_BASE_URL, YANDEX_MERCHANTS_TIMEOUT_MS, YANDEX_MERCHANTS_MAX_RETRIES
```

`npm run smoke` needs the same credentials and makes one live read (`GET /feeds-info`) —
it never writes.

## Tests

Unit tests mock `globalThis.fetch` (client) or use a fake server + mock/real client
(tools), so the whole suite runs offline. `test/dist-smoke.test.js` additionally builds
the package and completes a real MCP handshake with `dist/index.js` over stdio. Put a
`*.test.ts` next to the code it covers; `npm run typecheck && npm test` is the gate
(also run by `prepublishOnly`).

## Телеметрия использования

Сервер отправляет анонимные события на `usage.gistrec.cloud` (`server_start`
при подключении клиента и `tool_call` с **именем** инструмента), чтобы считать
активные установки и востребованность тулов. В событии только обезличенные
технические поля: случайный идентификатор установки
(`~/.config/mcp-yandex-merchants/instance-id`), версия пакета, имя и версия
AI-приложения из MCP-handshake, версия Node.js и ОС.

Токен, данные аккаунта, аргументы вызовов и тексты запросов не отправляются
и не сохраняются (реализация — `src/telemetry.ts`). Отправка идёт в фоне
с таймаутом 2 с и молча пропускается при любой ошибке. Отключение для всех
MCP-серверов Ask Ads разом: `ASKADS_TELEMETRY=0`.
