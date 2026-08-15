import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    run();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A missing token used to throw, which killed the process before the MCP
 * handshake and left the user with a dead server and no reason. It is now a
 * survivable state: the server starts, answers initialize/tools/list, and the
 * client raises CredentialsError at call time (pinned in client.test.ts).
 * Pinned here because reverting it would restore that dead end.
 */
test("a missing OAuth token does not throw — the server must start degraded", () => {
  withEnv({ YANDEX_MERCHANTS_OAUTH_TOKEN: undefined, YANDEX_MERCHANTS_BASE_URL: undefined }, () => {
    const config = loadConfig();
    assert.equal(config.token, undefined);
    assert.equal(config.apiBase, "https://yandex.ru/products/api/ext/partner");
  });
});

test("an empty value is treated as absent, not as an empty credential", () => {
  withEnv({ YANDEX_MERCHANTS_OAUTH_TOKEN: "" }, () => {
    assert.equal(loadConfig().token, undefined);
  });
});

test("a configured server loads with the default base and numeric defaults", () => {
  withEnv(
    {
      YANDEX_MERCHANTS_OAUTH_TOKEN: "tok",
      YANDEX_MERCHANTS_BASE_URL: undefined,
      YANDEX_MERCHANTS_TIMEOUT_MS: undefined,
      YANDEX_MERCHANTS_MAX_RETRIES: undefined,
    },
    () => {
      const config = loadConfig();
      assert.equal(config.token, "tok");
      assert.equal(config.apiBase, "https://yandex.ru/products/api/ext/partner");
      assert.equal(config.timeoutMs, 60_000);
      assert.equal(config.maxRetries, 3);
    },
  );
});

test("overrides are honored and junk numbers fall back to defaults", () => {
  withEnv(
    {
      YANDEX_MERCHANTS_OAUTH_TOKEN: "tok",
      YANDEX_MERCHANTS_BASE_URL: "http://127.0.0.1:8080/mock",
      YANDEX_MERCHANTS_TIMEOUT_MS: "1500",
      YANDEX_MERCHANTS_MAX_RETRIES: "not-a-number",
    },
    () => {
      const config = loadConfig();
      assert.equal(config.apiBase, "http://127.0.0.1:8080/mock");
      assert.equal(config.timeoutMs, 1500);
      assert.equal(config.maxRetries, 3);
    },
  );
});
