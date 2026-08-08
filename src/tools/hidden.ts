import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MerchantsClient } from "../client.js";
import { fail, feedId, offerId, ok, ttlInHours, WRITE, WRITE_IDEMPOTENT } from "./util.js";

export function registerHiddenTools(server: McpServer, client: MerchantsClient): void {
  server.registerTool(
    "hide_offer",
    {
      title: "Скрыть предложение из Поиска",
      annotations: WRITE,
      description:
        "Скрывает одно предложение из Поиска по товарам (POST /hidden-offers), например когда товар закончился. " +
        "ttl_in_hours — необязательный срок скрытия в часах (максимум 720 = 30 дней, иначе ошибка INVALID_TTL); повторное скрытие с ttl перезапускает срок. " +
        "Без ttl предложение скрыто до явного show_offers. Ответ API: { status: \"OK\" } либо { status: \"ERROR\", errors: [{ code, message }] }. " +
        "Прочитать список уже скрытых предложений через API нельзя. Лимит: 50 000 операций скрытия/показа в минуту.",
      inputSchema: {
        feed_id: feedId(),
        offer_id: offerId(),
        ttl_in_hours: ttlInHours().optional(),
      },
    },
    async ({ feed_id, offer_id, ttl_in_hours }) => {
      try {
        return ok(await client.hideOffers([{ feedId: feed_id, offerId: offer_id }], ttl_in_hours));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "hide_offers",
    {
      title: "Массовое скрытие предложений",
      annotations: WRITE,
      description:
        "Массово скрывает предложения из Поиска: от 1 до 500 за запрос (POST /hidden-offers). " +
        "Общий ttl_in_hours (максимум 720 часов) применяется ко всем предложениям запроса. " +
        "Ответ API: { status: \"OK\" } либо { status: \"ERROR\", errors: [...] }; коды: DUPLICATE_OFFER, INVALID_FEED_ID, INVALID_OFFER_ID, INVALID_TTL, " +
        "LIMIT_EXCEEDED, REQUEST_LIMIT_EXCEEDED (больше 500 в запросе). Лимит: 50 000 операций скрытия/показа в минуту (общий с show_offers).",
      inputSchema: {
        offers: z
          .array(z.object({ feed_id: feedId(), offer_id: offerId() }))
          .min(1)
          .max(500)
          .describe("Предложения для скрытия (1–500 за запрос)."),
        ttl_in_hours: ttlInHours().optional(),
      },
    },
    async ({ offers, ttl_in_hours }) => {
      try {
        return ok(
          await client.hideOffers(
            offers.map((o) => ({ feedId: o.feed_id, offerId: o.offer_id })),
            ttl_in_hours,
          ),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "show_offers",
    {
      title: "Возобновить показ предложений",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Возобновляет показ ранее скрытых предложений: от 1 до 500 за запрос (DELETE /hidden-offers с JSON-телом). " +
        "Ответ API: { status: \"OK\" } либо { status: \"ERROR\", errors: [...] }; коды: DUPLICATE_OFFER, INVALID_FEED_ID, INVALID_OFFER_ID, REQUEST_LIMIT_EXCEEDED. " +
        "Лимит: 50 000 операций скрытия/показа в минуту (общий с hide_offers).",
      inputSchema: {
        offers: z
          .array(z.object({ feed_id: feedId(), offer_id: offerId() }))
          .min(1)
          .max(500)
          .describe("Предложения, показ которых нужно возобновить (1–500 за запрос)."),
      },
    },
    async ({ offers }) => {
      try {
        return ok(await client.showOffers(offers.map((o) => ({ feedId: o.feed_id, offerId: o.offer_id }))));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
