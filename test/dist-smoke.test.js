import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MerchantsClient } from "../dist/client.js";
import { registerAuthTools } from "../dist/tools/auth.js";
import { registerFeedsTools } from "../dist/tools/feeds.js";
import { registerPricesTools } from "../dist/tools/prices.js";
import { registerHiddenTools } from "../dist/tools/hidden.js";
import { registerRawTool } from "../dist/tools/raw.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ALL_TOOLS = [
  "auth_status",
  "check_access",
  "finish_login",
  "hide_offer",
  "hide_offers",
  "list_feeds",
  "logout",
  "raw_request",
  "set_offer_discount",
  "set_offer_price",
  "show_offers",
  "start_login",
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
  const tokens = {};

  registerAuthTools(server, client, tokens);
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

/**
 * A server with no token at all: no env var, and a config dir that cannot hold a
 * stored login. Both halves matter — pointing XDG_CONFIG_HOME at a fresh temp dir
 * is what keeps the developer's own credentials.json from making these pass.
 */
function unconfiguredTransport(name) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("YANDEX_MERCHANTS_"),
    ),
  );
  env.ASKADS_TELEMETRY = "0"; // keep the suite offline
  env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), name));
  return new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env,
  });
}

/**
 * The degraded-start contract: without a token the server used to exit(1)
 * before the handshake, leaving the client a dead server and no reason. It must
 * now start, list every tool, open the instructions with the fix, and answer a
 * tool call with the actionable error — offline: the AuthRequiredError fires
 * before any fetch, so this test never touches the network.
 */
test("dist server starts without a token: handshake, tool list, actionable call error", async () => {
  const transport = unconfiguredTransport("mcp-merchants-unconfigured-");
  const mcp = new Client({ name: "dist-smoke-unconfigured", version: "0.0.0" });
  try {
    await mcp.connect(transport);

    // The model must read the fix before it picks a tool — both fixes now: the
    // in-chat login and the env variable.
    const instructions = mcp.getInstructions() ?? "";
    assert.match(instructions, /start_login/, "instructions must name the login tool");
    assert.match(instructions, /finish_login/, "and its second step");
    assert.match(instructions, /YANDEX_MERCHANTS_OAUTH_TOKEN/, "instructions must name the variable to set");
    assert.match(instructions, /перезапустить сервер/, "and say the env path needs a restart");

    const { tools } = await mcp.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ALL_TOOLS);

    // A tool call fails with the exact message instead of killing the server.
    const result = await mcp.callTool({ name: "list_feeds", arguments: {} });
    assert.equal(result.isError, true, "the call must fail, not the connection");
    const text = result.content.map((c) => c.text ?? "").join(" ");
    assert.match(text, /Яндекс Товары не подключены/, "the error must open with the state");
    assert.match(text, /start_login/, "the in-chat fix must be named");
    assert.match(text, /YANDEX_MERCHANTS_OAUTH_TOKEN/, "the env fix must be named");
    assert.match(text, /перезапустить сервер/, "and the env path's restart");
  } finally {
    await mcp.close();
  }
});

test("dist start_login hands back a PKCE authorize URL without touching the network", async () => {
  const transport = unconfiguredTransport("mcp-merchants-login-");
  const mcp = new Client({ name: "dist-smoke-login", version: "0.0.0" });
  try {
    await mcp.connect(transport);

    const status = await mcp.callTool({ name: "auth_status", arguments: {} });
    const parsedStatus = JSON.parse(status.content[0]?.text ?? "{}");
    assert.equal(parsedStatus.configured, false);
    assert.match(parsedStatus.path ?? "", /credentials\.json$/);

    const result = await mcp.callTool({ name: "start_login", arguments: {} });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    const url = new URL(payload.authorizeUrl ?? "");
    assert.equal(url.origin + url.pathname, "https://oauth.yandex.ru/authorize");
    assert.equal(url.searchParams.get("client_id"), "9e20243a34854a6f84156062be9cccf8");
    assert.equal(url.searchParams.get("scope"), "products:partner-api");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.ok(!url.search.includes("client_secret"), "a public client must not leak a secret");
    // No redirect ever comes back to this process, so there is no session for
    // state to tie together — PKCE alone binds the pasted code to the verifier.
    assert.equal(url.searchParams.get("state"), null, "the URL must not carry an unchecked state");
  } finally {
    await mcp.close();
  }
});
