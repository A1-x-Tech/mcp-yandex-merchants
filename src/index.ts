#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MerchantsClient } from "./client.js";
import { ConfigError, DEFAULT_BASE, loadConfig } from "./config.js";
import { instrumentToolCalls, Telemetry } from "./telemetry.js";
import type { MerchantsConfig } from "./types.js";
import { registerFeedsTools } from "./tools/feeds.js";
import { registerPricesTools } from "./tools/prices.js";
import { registerHiddenTools } from "./tools/hidden.js";
import { registerRawTool } from "./tools/raw.js";

/**
 * Prose handed to the calling model in the MCP `initialize` result, before it
 * picks a tool. Deliberately NOT a summary of the tool list (the model already
 * has every name, description and schema): only what the tool list cannot say —
 * which product this is, what the API refuses to do, what an ambiguous write
 * costs here, and which failures mean something other than what they look like.
 * Russian, like every tool description in this server; prepended to every
 * session, so it stays dense and factual.
 */
const INSTRUCTIONS =
  "Это партнёрский API Яндекс Товаров: точечная правка уже загруженного YML-фида, а не Яндекс " +
  "Маркет и не кабинет — заказов, остатков и карточек тут нет, фид создаётся и удаляется только в " +
  "кабинете или Вебмастере. API почти только пишет: читается лишь список фидов (feedId, feedUrl) — " +
  "текущую цену, состав фида и скрытые предложения узнать нечем, ведите учёт изменений сами. HTTP " +
  "200 — ещё не успех: проверяйте поле status в теле ответа (\"OK\" либо \"ERROR\" с errors). Потолок: " +
  "50 000 изменений цен и 50 000 скрытий/показов в минуту. Запись после 5xx или обрыва не " +
  "повторяется автоматически (429 — повторяется с задержкой): исход такого вызова неизвестен, а " +
  "перечитать состояние нечем — повторяйте осознанно. Пустой список фидов или ошибка доступа обычно " +
  "значит не «фидов нет», а токен не того логина (нужен тот, под которым загружен фид), отсутствие " +
  "scope products:partner-api либо только что подтверждённые права в Вебмастере — доступ " +
  "открывается через несколько часов. Всё, кроме check_access, list_feeds и raw_request с GET, " +
  "пишет в боевой аккаунт; feed_id берите из list_feeds.";

/**
 * Prepended to INSTRUCTIONS when the token is missing. The model reads this
 * before it picks a tool, so an unconfigured session opens with the fix rather
 * than with a failed call. There is no in-chat login here: the token comes only
 * from the environment, so the fix is an operator action + restart.
 */
const UNCONFIGURED_PREFIX =
  "ВНИМАНИЕ: Яндекс Товары ещё не подключены — не задана переменная окружения " +
  "YANDEX_MERCHANTS_OAUTH_TOKEN, поэтому любой вызов инструмента вернёт ошибку. Подключиться из " +
  "диалога нельзя: оператор должен задать YANDEX_MERCHANTS_OAUTH_TOKEN (OAuth-токен Яндекса со " +
  "scope products:partner-api — доступ «API поиска по товарам» приложения на oauth.yandex.ru, " +
  "токен получен под тем логином, который загрузил YML-фид) в конфигурации MCP-клиента и " +
  "перезапустить сервер. ";

/** Reads the package version so the server reports its real version to MCP clients. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Loads the config without dying on a bad value. A server that exits here never
 * completes the MCP handshake, so the user sees a dead server and no reason —
 * instead the problem is carried into the session, where the model can read it
 * and relay it. (A missing token is not an error at all — loadConfig leaves the
 * field undefined; today it has no malformed-value checks either, so the catch
 * guards future ones.)
 */
function loadConfigOrDegraded(telemetry: Telemetry): {
  config: MerchantsConfig;
  problem?: ConfigError;
} {
  try {
    return { config: loadConfig() };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Error: ${err.message}`);
    // Fire-and-forget now that the process survives: the historical
    // `startup_failed` funnel stays comparable, but nothing blocks startup.
    telemetry.send("startup_failed", { reason: err.reason });
    return {
      config: { apiBase: process.env.YANDEX_MERCHANTS_BASE_URL || DEFAULT_BASE },
      problem: err,
    };
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never data or arguments);
  // opt out with ASKADS_TELEMETRY=0. Built before the config so a config
  // problem can be reported; wired to the server before tools register.
  const telemetry = new Telemetry(readVersion());
  const { config, problem } = loadConfigOrDegraded(telemetry);
  const client = new MerchantsClient(config);

  // Decided once, at startup: the token comes only from the environment, so an
  // unconfigured start stays unconfigured until the operator sets the variable
  // and restarts the server — "restart" is the accurate advice to give.
  const connected = Boolean(config.token);

  // `instructions` rides in the server options (second argument) and surfaces as
  // the top-level `instructions` of the initialize result.
  const server = new McpServer(
    {
      name: "mcp-yandex-merchants",
      version: readVersion(),
    },
    {
      instructions: connected
        ? INSTRUCTIONS
        : UNCONFIGURED_PREFIX + (problem ? `Проблема конфигурации: ${problem.message} ` : "") + INSTRUCTIONS,
    },
  );

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    // Split on purpose: `server_start` keeps meaning "a usable install started",
    // so the unconfigured case gets its own event instead of inflating that
    // number. The reason vocabulary is the historical closed set.
    if (connected) telemetry.send("server_start");
    else telemetry.send("unconfigured_start", { reason: problem?.reason ?? "missing_token" });
  };

  registerFeedsTools(server, client);
  registerPricesTools(server, client);
  registerHiddenTools(server, client);
  registerRawTool(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `mcp-yandex-merchants running on stdio${
      connected ? "" : " (no YANDEX_MERCHANTS_OAUTH_TOKEN — set the variable and restart)"
    }`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting mcp-yandex-merchants:", err);
  process.exit(1);
});
