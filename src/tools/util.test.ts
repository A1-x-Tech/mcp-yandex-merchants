import { test } from "node:test";
import assert from "node:assert/strict";
import { errorMessage, fail, feedId, ok, offerId, price, READ_ONLY, ttlInHours, WRITE, WRITE_IDEMPOTENT } from "./util.js";

test("schema factories return independent schemas (no $ref dedup)", () => {
  assert.notEqual(feedId(), feedId());
  assert.notEqual(offerId(), offerId());
});

test("offerId caps at 50 chars; price must be positive; ttl caps at 720", () => {
  assert.equal(offerId().safeParse("a".repeat(50)).success, true);
  assert.equal(offerId().safeParse("a".repeat(51)).success, false);
  assert.equal(offerId().safeParse("").success, false);
  assert.equal(price().safeParse(0).success, false);
  assert.equal(price().safeParse(0.01).success, true);
  assert.equal(ttlInHours().safeParse(720).success, true);
  assert.equal(ttlInHours().safeParse(721).success, false);
  assert.equal(ttlInHours().safeParse(0).success, false);
});

test("ok emits compact JSON; fail flags isError", () => {
  assert.equal((ok({ a: 1 }).content[0] as { text: string }).text, '{"a":1}');
  const f = fail(new Error("boom"));
  assert.equal(f.isError, true);
  assert.match((f.content[0] as { text: string }).text, /boom/);
});

test("fail and errorMessage append the underlying cause when present", () => {
  const err = new Error("timeout", { cause: new Error("ECONNRESET") });
  assert.equal(errorMessage(err), "timeout (ECONNRESET)");
  const f = fail(err);
  assert.match((f.content[0] as { text: string }).text, /timeout \(ECONNRESET\)/);
});

test("annotation constants set all four hints explicitly", () => {
  assert.deepEqual(READ_ONLY, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
  assert.deepEqual(WRITE, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(WRITE_IDEMPOTENT, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  });
});
