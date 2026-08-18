import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TokenStore } from "../auth.js";
import { readCredentials } from "../credentials.js";
import { clearPendingLogin, startLogin } from "../oauth.js";
import { registerAuthTools } from "./auth.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/**
 * finish_login end to end, offline: a real TokenStore against a temp config
 * dir, the token exchange served by a stubbed global fetch, and a fake client
 * whose feedsInfo the test controls. That is the minimum that lets the test
 * watch the boundary this file is about — everything up to `save` is a failed
 * login, everything after it is not.
 */
async function withFinishLogin<T>(
  opts: { exchange: { status?: number; body: unknown }; feedsInfo: () => Promise<unknown> },
  run: (finishLogin: Handler) => Promise<T>,
): Promise<T> {
  const savedConfig = process.env.XDG_CONFIG_HOME;
  const savedFetch = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "mcp-merchants-tools-auth-"));
  globalThis.fetch = (async () =>
    ({
      ok: (opts.exchange.status ?? 200) < 400,
      status: opts.exchange.status ?? 200,
      text: async () => JSON.stringify(opts.exchange.body),
    }) as unknown as Response) as unknown as typeof fetch;

  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerAuthTools(server as never, { feedsInfo: opts.feedsInfo } as never, new TokenStore(undefined));

  try {
    startLogin();
    return await run(tools.finish_login);
  } finally {
    clearPendingLogin();
    globalThis.fetch = savedFetch;
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfig;
  }
}

test("a failed verification call after a saved token is not a failed login", async () => {
  await withFinishLogin(
    {
      exchange: { body: { access_token: "tok", refresh_token: "rt", expires_in: 3600 } },
      feedsInfo: async () => {
        throw new Error("fetch failed: network is unreachable");
      },
    },
    async (finishLogin) => {
      const res = await finishLogin({ code: "12345" });
      // The exchange worked and the token is on disk — reporting isError here
      // would send the user back to start_login for nothing.
      assert.notEqual(res.isError, true, "a saved login must not read as a failure");
      assert.equal(readCredentials()?.access_token, "tok", "the token really was saved");

      const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
      assert.equal(body.connected, true);
      assert.match(String(body.note), /сохранён/);
      assert.match(String(body.note), /Проверочный вызов к API не удался/);
      assert.match(String(body.note), /network is unreachable/, "the note must carry the real error");
      // The check never ran, so the answer must not claim anything about feeds.
      assert.ok(!("feedsVisible" in body), "no feeds claim when the check did not run");
    },
  );
});

test("a failed code exchange stays isError — nothing was saved", async () => {
  await withFinishLogin(
    {
      exchange: { status: 400, body: { error: "bad_verification_code" } },
      feedsInfo: async () => ({ feeds: [] }),
    },
    async (finishLogin) => {
      const res = await finishLogin({ code: "stale" });
      assert.equal(res.isError, true, "before save, a failure is a failed login");
      assert.equal(readCredentials(), undefined, "no token may appear on disk");
    },
  );
});

test("zero visible feeds still warns about a wrong-login token", async () => {
  await withFinishLogin(
    {
      exchange: { body: { access_token: "tok", expires_in: 3600 } },
      feedsInfo: async () => ({ feeds: [] }),
    },
    async (finishLogin) => {
      const res = await finishLogin({ code: "12345" });
      assert.notEqual(res.isError, true);
      const body = JSON.parse(res.content[0].text) as Record<string, unknown>;
      assert.equal(body.feedsVisible, 0);
      assert.match(String(body.note), /не тем логином|не под тем логином/);
    },
  );
});
