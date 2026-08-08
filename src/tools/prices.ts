import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MerchantsClient } from "../client.js";
import { fail, feedId, offerId, ok, payByCondition, price, WRITE_IDEMPOTENT } from "./util.js";

/** Discount bounds the API enforces (otherwise 400 Bad Request). */
const MIN_DISCOUNT_PCT = 5;
const MAX_DISCOUNT_PCT = 95;

export function registerPricesTools(server: McpServer, client: MerchantsClient): void {
  server.registerTool(
    "set_offer_price",
    {
      title: "Изменить цену предложения",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Изменяет цену одного товарного предложения (POST /offer-prices/updates c одним элементом). Валюта всегда RUR — подставляется автоматически. " +
        "Опционально: discount_base — цена до скидки (покажется зачёркнутой; скидка должна попадать в 5–95%, иначе API вернёт 400), " +
        "pay_by_price + pay_by_condition — спеццена при условии оплаты. " +
        "Ответ API: { status: \"OK\" } либо { status: \"ERROR\", errors: [{ code, message }] } — проверяйте status. " +
        "Если в фиде несколько предложений с одинаковым id, цена обновится только у первого. Лимит: 50 000 изменений цен в минуту.",
      inputSchema: {
        feed_id: feedId(),
        offer_id: offerId(),
        price: price(),
        discount_base: z
          .number()
          .positive()
          .optional()
          .describe("Цена до скидки (зачёркнутая), больше price; скидка 5–95%."),
        pay_by_price: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Спеццена при выполнении условия оплаты (целое, в рублях)."),
        pay_by_condition: payByCondition().optional(),
      },
    },
    async ({ feed_id, offer_id, price, discount_base, pay_by_price, pay_by_condition }) => {
      try {
        return ok(
          await client.updateOfferPrices([
            {
              feedId: feed_id,
              offerId: offer_id,
              price,
              discountBase: discount_base,
              payByPrice: pay_by_price,
              payByCondition: pay_by_condition,
            },
          ]),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_offer_prices",
    {
      title: "Массовое обновление цен",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Массово обновляет цены: от 1 до 2000 предложений одним запросом (POST /offer-prices/updates). Валюта всегда RUR. " +
        "Ответ API: { status: \"OK\" } либо { status: \"ERROR\", errors: [{ code, message }] }; " +
        "возможные коды: DUPLICATE_OFFER, INVALID_FEED_ID, INVALID_OFFER_ID, LIMIT_EXCEEDED, REQUEST_LIMIT_EXCEEDED (больше 2000 в запросе). " +
        "Лимит: 50 000 изменений цен в минуту. Для больших объёмов разбивайте на несколько вызовов.",
      inputSchema: {
        offers: z
          .array(
            z.object({
              feed_id: feedId(),
              offer_id: offerId(),
              price: price(),
              discount_base: z
                .number()
                .positive()
                .optional()
                .describe("Цена до скидки (зачёркнутая), больше price; скидка 5–95%."),
              pay_by_price: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Спеццена при выполнении условия оплаты (целое, в рублях)."),
              pay_by_condition: payByCondition().optional(),
            }),
          )
          .min(1)
          .max(2000)
          .describe("Предложения с новыми ценами (1–2000 за запрос)."),
      },
    },
    async ({ offers }) => {
      try {
        return ok(
          await client.updateOfferPrices(
            offers.map((o) => ({
              feedId: o.feed_id,
              offerId: o.offer_id,
              price: o.price,
              discountBase: o.discount_base,
              payByPrice: o.pay_by_price,
              payByCondition: o.pay_by_condition,
            })),
          ),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "set_offer_discount",
    {
      title: "Установить скидку на товар",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Устанавливает скидку: price — цена со скидкой, discount_base — старая цена, которая покажется зачёркнутой " +
        "(тот же POST /offer-prices/updates, но discount_base обязателен). Скидка должна быть не меньше 5% и не больше 95% — " +
        "проверяется до запроса, иначе API вернёт 400 Bad Request. Валюта всегда RUR. Ответ API: { status: \"OK\" } либо { status: \"ERROR\", errors: [...] }.",
      inputSchema: {
        feed_id: feedId(),
        offer_id: offerId(),
        price: price(),
        discount_base: z
          .number()
          .positive()
          .describe("Старая цена (зачёркнутая), обязательна и строго больше price."),
      },
    },
    async ({ feed_id, offer_id, price, discount_base }) => {
      if (discount_base <= price) {
        return fail(new Error("discount_base должен быть строго больше price."));
      }
      const discountPct = (1 - price / discount_base) * 100;
      if (discountPct < MIN_DISCOUNT_PCT || discountPct > MAX_DISCOUNT_PCT) {
        return fail(
          new Error(
            `Скидка ${discountPct.toFixed(1)}% вне допустимого диапазона ${MIN_DISCOUNT_PCT}–${MAX_DISCOUNT_PCT}% (API вернул бы 400).`,
          ),
        );
      }
      try {
        return ok(
          await client.updateOfferPrices([
            { feedId: feed_id, offerId: offer_id, price, discountBase: discount_base },
          ]),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
