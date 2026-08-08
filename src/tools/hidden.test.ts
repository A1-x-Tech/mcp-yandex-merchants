import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHiddenTools } from "./hidden.js";

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/** Fake server + fake client so the tool handlers run without network. */
function harness(opts: { throwOn?: string } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const make = (method: string) => async (...args: unknown[]) => {
    calls.push({ method, args });
    if (opts.throwOn === method) throw new Error("boom");
    return { status: "OK" };
  };
  const client = { hideOffers: make("hideOffers"), showOffers: make("showOffers") };
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerHiddenTools(server as never, client as never);
  return { calls, tools };
}

test("registers the three hide/show tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), ["hide_offer", "hide_offers", "show_offers"]);
});

test("hide_offer forwards a single ref and the ttl", async () => {
  const { calls, tools } = harness();
  await tools.hide_offer({ feed_id: 7, offer_id: "a", ttl_in_hours: 72 });
  assert.equal(calls[0].method, "hideOffers");
  assert.deepEqual(calls[0].args, [[{ feedId: 7, offerId: "a" }], 72]);
});

test("hide_offer without a ttl forwards undefined", async () => {
  const { calls, tools } = harness();
  await tools.hide_offer({ feed_id: 7, offer_id: "a" });
  assert.deepEqual(calls[0].args, [[{ feedId: 7, offerId: "a" }], undefined]);
});

test("hide_offers forwards the batch and the shared ttl", async () => {
  const { calls, tools } = harness();
  await tools.hide_offers({
    offers: [
      { feed_id: 7, offer_id: "a" },
      { feed_id: 8, offer_id: "b" },
    ],
    ttl_in_hours: 24,
  });
  assert.equal(calls[0].method, "hideOffers");
  assert.deepEqual(calls[0].args, [
    [
      { feedId: 7, offerId: "a" },
      { feedId: 8, offerId: "b" },
    ],
    24,
  ]);
});

test("show_offers forwards the batch to client.showOffers", async () => {
  const { calls, tools } = harness();
  await tools.show_offers({ offers: [{ feed_id: 7, offer_id: "a" }] });
  assert.equal(calls[0].method, "showOffers");
  assert.deepEqual(calls[0].args, [[{ feedId: 7, offerId: "a" }]]);
});

test("a client error is returned as an isError result, not thrown", async () => {
  const { tools } = harness({ throwOn: "showOffers" });
  const res = await tools.show_offers({ offers: [{ feed_id: 7, offer_id: "a" }] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});
