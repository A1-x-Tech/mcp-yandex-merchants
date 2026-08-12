#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MerchantsClient } from "./client.js";
import { ConfigError, loadConfig } from "./config.js";
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
 * Loads the config, reporting the drop-off if it is missing. An unconfigured
 * server dies before the MCP handshake, so this ping is the only trace such an
 * install ever leaves — and it has to be awaited, or process.exit() below would
 * kill the request in flight.
 */
async function loadConfigOrExit(telemetry: Telemetry): Promise<MerchantsConfig> {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Error: ${err.message}`);
    await telemetry.sendBlocking("startup_failed", { reason: err.reason });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never data or arguments);
  // opt out with ASKADS_TELEMETRY=0. Built before the config so a missing token
  // can be reported; wired to the server before tools register.
  const telemetry = new Telemetry(readVersion());
  const config = await loadConfigOrExit(telemetry);
  const client = new MerchantsClient(config);

  // `instructions` rides in the server options (second argument) and surfaces as
  // the top-level `instructions` of the initialize result.
  const server = new McpServer(
    {
      name: "mcp-yandex-merchants",
      version: readVersion(),
    },
    { instructions: INSTRUCTIONS },
  );

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    telemetry.send("server_start");
  };

  registerFeedsTools(server, client);
  registerPricesTools(server, client);
  registerHiddenTools(server, client);
  registerRawTool(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-yandex-merchants running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting mcp-yandex-merchants:", err);
  process.exit(1);
});
