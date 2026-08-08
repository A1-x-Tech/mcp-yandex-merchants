import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPricesTools } from "./prices.js";

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
  const client = { updateOfferPrices: make("updateOfferPrices") };
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _cfg: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  registerPricesTools(server as never, client as never);
  return { calls, tools };
}

test("registers the three price tools", () => {
  const { tools } = harness();
  assert.deepEqual(Object.keys(tools).sort(), [
    "set_offer_discount",
    "set_offer_price",
    "update_offer_prices",
  ]);
});

test("set_offer_price forwards one normalized update to the client", async () => {
  const { calls, tools } = harness();
  await tools.set_offer_price({
    feed_id: 1069,
    offer_id: "off-1",
    price: 1490,
    discount_base: 1990,
    pay_by_price: 1400,
    pay_by_condition: "yandex_pay",
  });
  assert.equal(calls[0].method, "updateOfferPrices");
  assert.deepEqual(calls[0].args[0], [
    {
      feedId: 1069,
      offerId: "off-1",
      price: 1490,
      discountBase: 1990,
      payByPrice: 1400,
      payByCondition: "yandex_pay",
    },
  ]);
});

test("update_offer_prices forwards the whole normalized batch", async () => {
  const { calls, tools } = harness();
  await tools.update_offer_prices({
    offers: [
      { feed_id: 1, offer_id: "a", price: 10 },
      { feed_id: 1, offer_id: "b", price: 20, discount_base: 40 },
    ],
  });
  assert.deepEqual(calls[0].args[0], [
    { feedId: 1, offerId: "a", price: 10, discountBase: undefined, payByPrice: undefined, payByCondition: undefined },
    { feedId: 1, offerId: "b", price: 20, discountBase: 40, payByPrice: undefined, payByCondition: undefined },
  ]);
});

test("set_offer_discount forwards a valid discount", async () => {
  const { calls, tools } = harness();
  const res = await tools.set_offer_discount({ feed_id: 1, offer_id: "a", price: 900, discount_base: 1000 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls[0].args[0], [{ feedId: 1, offerId: "a", price: 900, discountBase: 1000 }]);
});

test("set_offer_discount rejects discount_base <= price without calling the API", async () => {
  const { calls, tools } = harness();
  const res = await tools.set_offer_discount({ feed_id: 1, offer_id: "a", price: 1000, discount_base: 1000 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /discount_base/);
  assert.equal(calls.length, 0, "invalid input must not reach the API");
});

test("set_offer_discount enforces the 5–95% window MCP-side", async () => {
  const { calls, tools } = harness();
  // 2% discount — below the 5% minimum.
  const tooSmall = await tools.set_offer_discount({ feed_id: 1, offer_id: "a", price: 980, discount_base: 1000 });
  assert.equal(tooSmall.isError, true);
  assert.match(tooSmall.content[0].text, /5–95%/);
  // 98% discount — above the 95% maximum.
  const tooBig = await tools.set_offer_discount({ feed_id: 1, offer_id: "a", price: 20, discount_base: 1000 });
  assert.equal(tooBig.isError, true);
  assert.equal(calls.length, 0, "invalid discounts must not reach the API");
});

test("set_offer_price rejects half a pay_by pair without calling the API", async () => {
  const { calls, tools } = harness();
  const noCondition = await tools.set_offer_price({ feed_id: 1, offer_id: "a", price: 10, pay_by_price: 9 });
  assert.equal(noCondition.isError, true);
  assert.match(noCondition.content[0].text, /pay_by_price и pay_by_condition/);
  const noPrice = await tools.set_offer_price({ feed_id: 1, offer_id: "a", price: 10, pay_by_condition: "yandex_pay" });
  assert.equal(noPrice.isError, true);
  assert.equal(calls.length, 0, "half a payBy pair must not reach the API");
});

test("update_offer_prices rejects half a pay_by pair, naming the offending element", async () => {
  const { calls, tools } = harness();
  const res = await tools.update_offer_prices({
    offers: [
      { feed_id: 1, offer_id: "a", price: 10 },
      { feed_id: 1, offer_id: "b", price: 20, pay_by_condition: "ozon_card" },
    ],
  });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /offers\[1\]/);
  assert.equal(calls.length, 0, "half a payBy pair must not reach the API");
});

test("a client error is returned as an isError result, not thrown", async () => {
  const { tools } = harness({ throwOn: "updateOfferPrices" });
  const res = await tools.set_offer_price({ feed_id: 1, offer_id: "a", price: 10 });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /boom/);
});
