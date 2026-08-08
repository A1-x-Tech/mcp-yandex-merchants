import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFeedsTools } from "./feeds.js";
import { registerPricesTools } from "./prices.js";
import { registerHiddenTools } from "./hidden.js";
import { registerRawTool } from "./raw.js";
import { READ_ONLY, WRITE, WRITE_IDEMPOTENT } from "./util.js";

interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Registers every tool against a fake server, capturing each tool's annotations. */
function collectAnnotations(): Record<string, Annotations | undefined> {
  const annotations: Record<string, Annotations | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Annotations }) => {
      annotations[name] = cfg.annotations;
    },
  };
  // Registration reads the client only inside handlers, so a stub is fine here.
  registerFeedsTools(server as never, {} as never);
  registerPricesTools(server as never, {} as never);
  registerHiddenTools(server as never, {} as never);
  registerRawTool(server as never, {} as never);
  return annotations;
}

const ANN = collectAnnotations();

/**
 * The pinned map tool → expected hints. This is a WRITE API: only the
 * feeds-info wrappers are read-only; hides (repeat-with-TTL semantics are
 * undocumented) and raw_request are non-idempotent writes; price sets and
 * unhide are state-setting writes.
 */
const EXPECTED: Record<string, Annotations> = {
  list_feeds: READ_ONLY,
  check_access: READ_ONLY,
  set_offer_price: WRITE_IDEMPOTENT,
  update_offer_prices: WRITE_IDEMPOTENT,
  set_offer_discount: WRITE_IDEMPOTENT,
  hide_offer: WRITE,
  hide_offers: WRITE,
  show_offers: WRITE_IDEMPOTENT,
  raw_request: WRITE,
};

test("registers all nine tools with annotations", () => {
  assert.deepEqual(Object.keys(ANN).sort(), Object.keys(EXPECTED).sort());
  for (const [name, a] of Object.entries(ANN)) {
    assert.ok(a, `${name} is missing annotations`);
  }
});

test("every tool carries exactly its expected hints (all four set)", () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    assert.deepEqual(ANN[name], expected, `${name} annotations drifted`);
  }
});

test("no write tool masquerades as read-only", () => {
  for (const [name, a] of Object.entries(ANN)) {
    const shouldBeReadOnly = EXPECTED[name] === READ_ONLY;
    assert.equal(a?.readOnlyHint, shouldBeReadOnly, `${name} readOnlyHint`);
    // Nothing in this API is irreversible — destructiveHint stays false everywhere.
    assert.equal(a?.destructiveHint, false, `${name} destructiveHint`);
    assert.equal(a?.openWorldHint, true, `${name} openWorldHint`);
  }
});
