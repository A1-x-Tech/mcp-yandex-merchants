import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TokenStore } from "../auth.js";
import type { MerchantsClient } from "../client.js";
import {
  clearPendingLogin,
  exchangeCode,
  oauthClientId,
  pendingLogin,
  startLogin,
} from "../oauth.js";
import { fail, ok, READ_ONLY, WRITE_DELETE, WRITE_IDEMPOTENT } from "./util.js";

/**
 * The in-chat login. Two steps because the user has to leave for the browser in
 * between: `start_login` hands out a URL, `finish_login` redeems the code they
 * bring back. The PKCE verifier never leaves this process, so the code passing
 * through the chat is useless to anyone who reads it — and it dies in 10 minutes.
 */
export function registerAuthTools(
  server: McpServer,
  client: MerchantsClient,
  tokens: TokenStore,
): void {
  server.registerTool(
    "auth_status",
    {
      title: "Статус подключения к Яндекс Товарам",
      annotations: READ_ONLY,
      description:
        "Показывает, подключены ли Яндекс Товары: есть ли токен, откуда он взят (переменная окружения YANDEX_MERCHANTS_OAUTH_TOKEN или сохранённый вход), когда истекает и где лежит файл с сохранёнными данными. Ничего не отправляет в сеть и не показывает сам токен. Вызовите это, если инструменты отвечают, что подключение не настроено; живую проверку доступа к API делает check_access.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(tokens.status());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "start_login",
    {
      title: "Начать подключение Яндекс Товаров",
      annotations: READ_ONLY,
      description:
        "Первый шаг подключения Яндекс Товаров без правки конфигурации и без перезапуска клиента. Возвращает ссылку на страницу Яндекс OAuth. Покажите ссылку пользователю целиком и попросите: открыть её в браузере строго под тем логином Яндекса, под которым загружен YML-фид (токен другого логина не увидит ни одного фида), подтвердить доступ и прислать показанный код подтверждения. Токен выдаётся со scope products:partner-api. Полученный код передайте в finish_login. Код действует 10 минут. Сам по себе код бесполезен для постороннего: обменять его может только этот сервер.",
      inputSchema: {},
    },
    async () => {
      try {
        const { authorizeUrl } = startLogin();
        return ok({
          authorizeUrl,
          clientId: oauthClientId(),
          expiresInMinutes: 10,
          nextStep:
            "Покажите пользователю ссылку authorizeUrl, напомните войти под логином, загрузившим фид, дождитесь кода подтверждения и вызовите finish_login с этим кодом.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "finish_login",
    {
      title: "Завершить подключение Яндекс Товаров",
      annotations: WRITE_IDEMPOTENT,
      description:
        "Второй шаг подключения: обменивает код подтверждения из start_login на токен доступа, сохраняет его в файл только для владельца (0600) и сразу проверяет живым запросом к списку фидов. После успеха остальные инструменты работают немедленно — перезапускать клиент не нужно. Если фидов не видно, вход, скорее всего, выполнен не под тем логином (нужен тот, что загрузил YML-фид). Код одноразовый и живёт 10 минут: если он не принят, вызовите start_login заново и попросите свежий.",
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe("Код подтверждения, который Яндекс показал пользователю после входа."),
      },
    },
    async ({ code }) => {
      try {
        const pending = pendingLogin();
        if (!pending) {
          return fail(
            "Нет активного запроса на подключение (или он истёк — он живёт 10 минут). " +
              "Вызовите start_login и повторите вход.",
          );
        }

        const response = await exchangeCode({
          code: code.trim(),
          verifier: pending.verifier,
          clientId: pending.clientId,
        });
        tokens.save(response);
        clearPendingLogin();

        // Prove it works before telling the user it does: a token that
        // authenticates but sees no feeds is a wrong-login token (the API shows
        // feeds only to the login that uploaded them), and saying "готово" there
        // just moves the confusion one step later.
        const feedsInfo = (await client.feedsInfo()) as { feeds?: unknown };
        const found = Array.isArray(feedsInfo.feeds) ? feedsInfo.feeds.length : 0;

        return ok({
          connected: true,
          feedsVisible: found,
          storedAt: tokens.status().path,
          // Present only when Yandex granted less than SCOPE asked for — worth
          // surfacing, because the failure it causes shows up later as a bare 403.
          grantedScope: response.scope,
          note:
            found === 0
              ? "Токен сохранён, но этому логину не видно ни одного фида — вероятно, вход выполнен не под тем логином Яндекса (нужен тот, который загрузил YML-фид), либо права в Вебмастере подтверждены недавно и доступ ещё не открылся. Сообщите об этом пользователю и при необходимости повторите start_login."
              : "Подключение готово, инструменты Яндекс Товаров можно вызывать сразу.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "logout",
    {
      title: "Отключить Яндекс Товары",
      annotations: WRITE_DELETE,
      description:
        "Удаляет сохранённый токен Яндекс Товаров с диска. Токен, заданный переменной окружения YANDEX_MERCHANTS_OAUTH_TOKEN, не трогает — его нужно убирать из конфигурации клиента вручную. Доступ, выданный приложению, остаётся активным на стороне Яндекса: отозвать его можно в Яндекс ID.",
      inputSchema: {},
    },
    async () => {
      try {
        const removed = tokens.logout();
        clearPendingLogin();
        return ok({
          removed,
          note: removed
            ? "Сохранённый токен удалён."
            : "Сохранённого токена не было — удалять нечего.",
          envTokenStillSet: tokens.status().source === "env",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
