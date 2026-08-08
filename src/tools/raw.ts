import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpMethod, MerchantsClient } from "../client.js";
import { fail, ok, WRITE } from "./util.js";

export function registerRawTool(server: McpServer, client: MerchantsClient): void {
  server.registerTool(
    "raw_request",
    {
      // The API has write endpoints and raw can reach any of them, so this is not READ_ONLY.
      annotations: WRITE,
      title: "Прямой вызов Merchants API",
      description:
        "Запасной выход: прямой вызов любого пути партнёрского API Яндекс Товаров относительно базового URL " +
        "(https://yandex.ru/products/api/ext/partner), например \"feeds-info\" или \"offer-prices/updates\". " +
        "Методы API: GET (feeds-info), POST (offer-prices/updates, hidden-offers), DELETE (hidden-offers). " +
        "body отправляется как JSON в готовом wire-формате API (например { offers: [...] } или { hiddenOffers: [...] }) — без преобразований.",
      inputSchema: {
        path: z.string().min(1).describe('Путь API относительно базового URL, например "feeds-info".'),
        method: z
          .enum(["GET", "POST", "DELETE"])
          .optional()
          .describe("HTTP-метод; по умолчанию GET."),
        body: z.record(z.any()).optional().describe("JSON-тело запроса в wire-формате API (для POST/DELETE)."),
      },
    },
    async ({ path, method, body }) => {
      try {
        const m = (method ?? "GET") as HttpMethod;
        return ok(await client.request(m, path, body));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
