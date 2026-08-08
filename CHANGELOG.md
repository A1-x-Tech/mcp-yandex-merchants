# Changelog

Все заметные изменения проекта документируются в этом файле.

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версионирование — [SemVer](https://semver.org/lang/ru/).

## [Unreleased]

## [0.1.0] — 2026-08-09

Первый рабочий релиз (до этого имя пакета было зарезервировано заглушкой 0.0.1).

### Added

- MCP-сервер (stdio) для партнёрского API Яндекс Товаров
  (`https://yandex.ru/products/api/ext/partner`, OAuth-токен со scope `products:partner-api`).
- Инструменты: `list_feeds`, `check_access`, `set_offer_price`, `update_offer_prices`,
  `set_offer_discount` (валидация скидки 5–95% до запроса), `hide_offer`, `hide_offers`,
  `show_offers`, `raw_request` (GET/POST/DELETE, SSRF-guard).
- HTTP-клиент: таймаут с AbortController, ретраи 429 (всегда) и 5xx/сеть (только GET,
  чтобы не дублировать записи), бэкофф с учётом `Retry-After`, `MerchantsError`
  с разбором `{ status, errors[] }`.
- Анонимная телеметрия использования (opt-out `ASKADS_TELEMETRY=0`).
- Тесты: node:test (клиент, тулы, конфиг, телеметрия) + dist-smoke с реальным
  MCP-хендшейком по stdio; CI на Node 20/22/24.
