import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFeedsTools } from "./feeds.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Fake server + fake client so the tool handlers run without network. */
function harness(opts: { throwOn?: string; feedsResult?: unknown } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const make = (method: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (opts.throwOn === method) throw new Error("boom");
    return result;
  };
  const client = {
    feedsInfo: make(
      "feedsInfo",
      opts.feedsResult ?? { status: "OK", feeds: [{ feedId: 1069, feedUrl: "https://shop.example/feed.yml" }] },
    ),
  };
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerFeedsTools(server as never, client as never);
  return { calls, tools };
}

test("registers the two feed tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), ["check_access", "list_feeds"]);
});

test("list_feeds passes the feeds-info response through verbatim", async () => {
  const { calls, tools } = harness();
  const res = await tools.list_feeds({});
  assert.equal(calls[0].method, "feedsInfo");
  assert.deepEqual(JSON.parse(res.content[0].text), {
    status: "OK",
    feeds: [{ feedId: 1069, feedUrl: "https://shop.example/feed.yml" }],
  });
});

test("check_access reports ok + feedsCount on success", async () => {
  const { tools } = harness();
  const res = await tools.check_access({});
  assert.equal(res.isError, undefined);
  assert.deepEqual(JSON.parse(res.content[0].text), { ok: true, feedsCount: 1 });
});

test("check_access reports ok:false with the error as data, not isError", async () => {
  const { tools } = harness({ throwOn: "feedsInfo" });
  const res = await tools.check_access({});
  assert.equal(res.isError, undefined, "diagnostics report failures as data");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /boom/);
});

test("check_access tolerates a feeds-less response", async () => {
  const { tools } = harness({ feedsResult: { status: "OK" } });
  const res = await tools.check_access({});
  assert.deepEqual(JSON.parse(res.content[0].text), { ok: true, feedsCount: 0 });
});

test("a client error in list_feeds is returned as an isError result, not thrown", async () => {
  const { tools } = harness({ throwOn: "feedsInfo" });
  const res = await tools.list_feeds({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});
