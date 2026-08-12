import assert from "node:assert/strict";
import test from "node:test";

import { MerchantsClient } from "../dist/client.js";
import { registerFeedsTools } from "../dist/tools/feeds.js";
import { registerPricesTools } from "../dist/tools/prices.js";
import { registerHiddenTools } from "../dist/tools/hidden.js";
import { registerRawTool } from "../dist/tools/raw.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ALL_TOOLS = [
  "check_access",
  "hide_offer",
  "hide_offers",
  "list_feeds",
  "raw_request",
  "set_offer_discount",
  "set_offer_price",
  "show_offers",
  "update_offer_prices",
];

test("dist client rejects foreign-origin paths before sending the OAuth token", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };

  const client = new MerchantsClient({
    token: "SECRET",
    apiBase: "https://yandex.ru/products/api/ext/partner",
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await assert.rejects(() => client.request("GET", "https://example.invalid/steal"), /foreign origin/);
  assert.equal(called, false);
});

test("dist client keeps the wire mapping: OAuth header and pinned RUR currency", async () => {
  let sent;
  let auth;
  globalThis.fetch = async (_url, init) => {
    auth = init.headers.Authorization;
    sent = JSON.parse(init.body);
    return new Response('{"status":"OK"}', { status: 200 });
  };

  const client = new MerchantsClient({
    token: "SECRET",
    apiBase: "https://yandex.ru/products/api/ext/partner",
    timeoutMs: 1000,
    maxRetries: 0,
  });

  await client.updateOfferPrices([{ feedId: 1, offerId: "a", price: 10 }]);
  assert.equal(auth, "OAuth SECRET");
  assert.deepEqual(sent, {
    offers: [{ feed: { id: 1 }, id: "a", price: { currencyId: "RUR", value: 10 } }],
  });
});

test("dist registers the expected tools", () => {
  const names = [];
  const server = {
    registerTool(name) {
      names.push(name);
    },
  };
  const client = {};

  registerFeedsTools(server, client);
  registerPricesTools(server, client);
  registerHiddenTools(server, client);
  registerRawTool(server, client);

  assert.deepEqual(names.sort(), ALL_TOOLS);
});

test("dist server completes a real MCP handshake over stdio, lists all tools and hands over instructions", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: {
      ...process.env,
      YANDEX_MERCHANTS_OAUTH_TOKEN: "test-token",
      ASKADS_TELEMETRY: "0",
    },
  });
  const mcp = new Client({ name: "dist-smoke", version: "0.0.0" });
  try {
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);
    const serverInfo = mcp.getServerVersion();
    assert.equal(serverInfo?.name, "mcp-yandex-merchants");

    // instructions live only in the initialize result, so this live handshake is
    // the only place that proves they survived the build. Length floor instead of
    // a wording match: catches an empty or placeholder string without pinning the
    // test to the prose.
    const instructions = mcp.getInstructions();
    assert.equal(typeof instructions, "string");
    assert.ok(instructions.trim().length > 200, "instructions must carry real guidance");
  } finally {
    await mcp.close();
  }
});
