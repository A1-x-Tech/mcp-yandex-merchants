# Yandex Merchants MCP

[![npm](https://img.shields.io/npm/v/mcp-yandex-merchants)](https://www.npmjs.com/package/mcp-yandex-merchants)
[![CI](https://github.com/A1-x-Tech/mcp-yandex-merchants/actions/workflows/ci.yml/badge.svg)](https://github.com/A1-x-Tech/mcp-yandex-merchants/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

MCP-сервер для **Яндекс Товаров** ([merchants.yandex.ru](https://merchants.yandex.ru)):
управляйте товарными предложениями — ценами, скидками, скрытием и показом — из Claude,
Cursor, Codex и других AI-клиентов на естественном языке.

Ассистент сам находит нужный фид, обновляет цены (в том числе массово, до 2000 за запрос),
ставит зачёркнутые «старые» цены и скрывает закончившиеся товары из Поиска — без ручной
правки фида и ожидания его переиндексации.

## Быстрый старт

1. [Получите OAuth-токен](#получение-доступа) со scope `products:partner-api`.
2. Добавьте сервер — например, в Claude Code ([другие клиенты](#установка)):

   ```bash
   claude mcp add yandex-merchants \
     -e YANDEX_MERCHANTS_OAUTH_TOKEN=ваш_токен \
     -- npx -y mcp-yandex-merchants
   ```

3. Спросите ассистента: «Покажи мои товарные фиды и поставь на товар SKU-123 цену 1490 ₽».

## Что умеет

- **Список фидов** — `list_feeds`: id и URL фидов, доступных логину (точка входа: `feedId`
  нужен всем остальным инструментам).
- **Диагностика** — `check_access`: проверка токена и доступа к API (`{ ok, feedsCount }`).
- **Цены** — `set_offer_price` (один товар), `update_offer_prices` (1–2000 за запрос):
  новая цена, зачёркнутая цена `discount_base`, спеццена при оплате Яндекс Пэй / СБП / картой Озон.
- **Скидки** — `set_offer_discount`: цена со скидкой + старая цена; диапазон 5–95 %
  проверяется до запроса.
- **Скрытие/показ** — `hide_offer`, `hide_offers` (1–500, опционально на срок до 720 часов),
  `show_offers` — товар кончился → скрыли, появился → показали.
- **Универсальный `raw_request`** — прямой вызов любого пути API.
- **Устойчивость** — ретраи на 429 с бэкоффом (5xx/сеть — только для чтения, чтобы не
  дублировать записи) и таймаут запроса.

## Примеры запросов

Попросите ассистента на русском — например:

- «Какие у меня фиды в Яндекс Товарах и работает ли токен?»
- «Поставь на товар SKU-123 из фида 1069 цену 1490 ₽ с зачёркнутой 1990 ₽»
- «Подними цены на эти 50 позиций на 10%» (со списком)
- «Скрой из Поиска товары SKU-7 и SKU-8 на 72 часа — они закончились»

## Доступ к API

Сервер работает через **партнёрский API Яндекс Товаров** («API поиска по товарам»,
`https://yandex.ru/products/api/ext/partner`), авторизация — OAuth-токен Яндекса со scope
`products:partner-api`, заголовок `Authorization: OAuth <токен>`.

> **Токен должен быть получен под тем логином, под которым загружался YML-фид** (в Вебмастере
> или кабинете Яндекс Товаров) — иначе API не увидит фиды. API открывается через несколько
> часов после подтверждения прав на сайт в Вебмастере.

API маленький и write-ориентированный: 4 эндпоинта (список фидов, цены, скрытие, показ).
Прочитать текущие цены, список скрытых предложений или статус фида через API нельзя;
создание и удаление фидов — только через кабинет или Вебмастер.

## Установка

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add yandex-merchants \
  -e YANDEX_MERCHANTS_OAUTH_TOKEN=ваш_токен \
  -- npx -y mcp-yandex-merchants
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json` — macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`

```json
{
  "mcpServers": {
    "yandex-merchants": {
      "command": "npx",
      "args": ["-y", "mcp-yandex-merchants"],
      "env": { "YANDEX_MERCHANTS_OAUTH_TOKEN": "ваш_токен" }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (или `.cursor/mcp.json` в проекте)

```json
{
  "mcpServers": {
    "yandex-merchants": {
      "command": "npx",
      "args": ["-y", "mcp-yandex-merchants"],
      "env": { "YANDEX_MERCHANTS_OAUTH_TOKEN": "ваш_токен" }
    }
  }
}
```

</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json` — ключ `servers` (не `mcpServers`)

```json
{
  "servers": {
    "yandex-merchants": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-yandex-merchants"],
      "env": { "YANDEX_MERCHANTS_OAUTH_TOKEN": "ваш_токен" }
    }
  }
}
```

</details>

## Получение доступа

1. Зарегистрируйте приложение на [oauth.yandex.ru/client/new](https://oauth.yandex.ru/client/new):
   платформа «веб-сервисы», Redirect URI `https://oauth.yandex.ru/verification_code`,
   доступ (scope) — **`products:partner-api`** («API поиска по товарам»).
2. Скопируйте ClientID и откройте
   `https://oauth.yandex.ru/authorize?response_type=token&client_id=<ClientID>`
   **под логином, который загружал фид**.
3. Скопируйте токен со страницы подтверждения и запишите его в
   `YANDEX_MERCHANTS_OAUTH_TOKEN`.
4. Проверьте подключение инструментом `check_access` (или `npm run smoke`).

⚠️ Токен хранится **открытым текстом** в конфиге клиента — относитесь как к паролю.

## Настройка

| Переменная | Обяз. | По умолчанию | Описание |
|---|---|---|---|
| `YANDEX_MERCHANTS_OAUTH_TOKEN` | да | — | OAuth-токен Яндекса со scope `products:partner-api`. |
| `YANDEX_MERCHANTS_BASE_URL` | нет | `https://yandex.ru/products/api/ext/partner` | Корень API (override). |
| `YANDEX_MERCHANTS_TIMEOUT_MS` | нет | `60000` | Таймаут запроса, мс. |
| `YANDEX_MERCHANTS_MAX_RETRIES` | нет | `3` | Повторы: 429 — всегда, 5xx/сеть — только GET. |

## Требования

- Node.js 20+ (запускается через `npx`, отдельная установка не нужна).
- Доступ к партнёрскому API Яндекс Товаров — см. [Получение доступа](#получение-доступа).

## Ограничения

- **Write-mostly API.** Единственное чтение — список фидов; текущие цены, скрытые
  предложения и статус фида через API недоступны.
- **Валюта только RUR** — цены в других валютах API не принимает.
- **Лимиты**: до 50 000 изменений цен в минуту и до 50 000 операций скрытия/показа в минуту;
  батчи ≤ 2000 (цены) и ≤ 500 (скрытие/показ) за запрос.
- **Срок скрытия** `ttl_in_hours` — максимум 720 часов (30 дней).

## Документация

- [Все инструменты](https://github.com/A1-x-Tech/mcp-yandex-merchants/blob/main/docs/TOOLS.md) — полный список с описанием.
- [Разработка](https://github.com/A1-x-Tech/mcp-yandex-merchants/blob/main/docs/DEVELOPMENT.md) — сборка, тесты, smoke-проверка.
- [Публикация](https://github.com/A1-x-Tech/mcp-yandex-merchants/blob/main/docs/PUBLISHING.md) — релиз и листинг в каталогах MCP.
- [Справочник API Яндекс Товаров](https://yandex.ru/dev/products/doc/ru/) — официальная документация.

## Поддержка

Вопросы, идеи и доработки — пишите в Telegram: [@gistrec](http://t.me/gistrec).

## Лицензия

MIT — см. [LICENSE](./LICENSE).
