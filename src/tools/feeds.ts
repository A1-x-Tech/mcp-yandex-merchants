import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MerchantsClient } from "../client.js";
import { errorMessage, fail, ok, READ_ONLY } from "./util.js";

export function registerFeedsTools(server: McpServer, client: MerchantsClient): void {
  server.registerTool(
    "list_feeds",
    {
      title: "Список товарных фидов",
      annotations: READ_ONLY,
      description:
        "Возвращает список товарных фидов, доступных текущему OAuth-логину: { status, feeds: [{ feedId, feedUrl }] }. " +
        "Точка входа для всех остальных инструментов — их параметр feed_id берётся из feedId этого ответа. " +
        "Больше API про фиды ничего не отдаёт: ни статуса фида, ни списка предложений (создание/удаление фида — только через кабинет или Вебмастер).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await client.feedsInfo());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "check_access",
    {
      title: "Проверка токена и доступа",
      annotations: READ_ONLY,
      description:
        "Диагностика подключения: выполняет тот же GET /feeds-info и возвращает { ok, feedsCount } либо { ok: false, error }. " +
        "Отдельного ping-эндпоинта в API нет. Если ok: false — проверьте, что OAuth-токен выдан со scope products:partner-api " +
        "под тем логином, который загружал фид, и что права на сайт подтверждены в Вебмастере (API открывается через несколько часов после подтверждения).",
      inputSchema: {},
    },
    async () => {
      try {
        const res = (await client.feedsInfo()) as { feeds?: unknown };
        const feeds = res && Array.isArray(res.feeds) ? res.feeds : [];
        return ok({ ok: true, feedsCount: feeds.length });
      } catch (e) {
        // Diagnostics: the failure IS the answer, so report it as data, not isError.
        return ok({ ok: false, error: errorMessage(e) });
      }
    },
  );
}
