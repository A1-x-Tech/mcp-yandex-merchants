import { test } from "node:test";
import assert from "node:assert/strict";

import { ConfigError, loadConfig } from "./config.js";

/**
 * The reason codes below are the vocabulary the dashboard groups by — renaming
 * one silently splits a bar in two, so they are pinned here.
 */
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

test("a missing OAuth token reports missing_token", () => {
  let caught: unknown;
  withEnv({ YANDEX_MERCHANTS_OAUTH_TOKEN: undefined }, () => {
    try {
      loadConfig();
    } catch (err) {
      caught = err;
    }
  });
  assert.ok(caught instanceof ConfigError, "config problems must throw ConfigError, not exit");
  assert.equal(caught.reason, "missing_token");
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
