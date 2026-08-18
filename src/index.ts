#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenStore } from "./auth.js";
import { MerchantsClient } from "./client.js";
import { ConfigError, DEFAULT_BASE, loadConfig } from "./config.js";
import { instrumentToolCalls, Telemetry } from "./telemetry.js";
import type { MerchantsConfig } from "./types.js";
import { registerAuthTools } from "./tools/auth.js";
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
 * Prepended to INSTRUCTIONS when no token is available. The model reads this
 * before it picks a tool, so an unconfigured session opens with the fix rather
 * than with a failed call.
 */
const UNCONFIGURED_PREFIX =
  "ВНИМАНИЕ: Яндекс Товары ещё не подключены — токена нет, поэтому любой инструмент данных " +
  "вернёт ошибку. Подключение делается прямо в диалоге и без перезапуска клиента: вызовите " +
  "start_login, покажите пользователю ссылку, попросите войти строго под тем логином Яндекса, " +
  "под которым загружен YML-фид (токен другого логина не увидит ни одного фида), и прислать " +
  "код подтверждения, затем передайте код в finish_login. Альтернатива — задать " +
  "YANDEX_MERCHANTS_OAUTH_TOKEN (OAuth-токен со scope products:partner-api под логином, " +
  "загрузившим фид) в конфигурации MCP-клиента и перезапустить сервер. ";

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
  const tokens = new TokenStore(config.token);
  const client = new MerchantsClient(config, tokens);

  // Resolved once, at startup, only to pick the instructions text: the token
  // itself is re-read per request, so a login mid-session still takes effect.
  const connected = tokens.hasToken();

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

  registerAuthTools(server, client, tokens);
  registerFeedsTools(server, client);
  registerPricesTools(server, client);
  registerHiddenTools(server, client);
  registerRawTool(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `mcp-yandex-merchants running on stdio${
      connected ? "" : " (no token — log in via start_login or set YANDEX_MERCHANTS_OAUTH_TOKEN)"
    }`,
  );
}

main().catch((err) => {
  console.error("Fatal error starting mcp-yandex-merchants:", err);
  process.exit(1);
});
