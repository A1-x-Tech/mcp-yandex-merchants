import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/**
 * Shared zod schema FACTORIES (not shared consts): reusing one zod object across
 * two fields makes zod-to-json-schema dedupe them into a `$ref` (e.g. offer_id →
 * #/properties/…), which some tool-schema consumers (OpenAI Apps review) don't
 * dereference and flag as `any`. A fresh object per field keeps each one inlined
 * with its type + constraints.
 */

/** Feed id — int64 from list_feeds. */
export const feedId = () =>
  z.number().int().describe("Идентификатор фида (feedId из list_feeds).");

/** Offer id from the feed, ≤ 50 chars per the API. */
export const offerId = () =>
  z
    .string()
    .min(1)
    .max(50)
    .describe("Идентификатор предложения из фида (id в YML, до 50 символов).");

/** A positive price in RUR (the only currency the API accepts). */
export const price = () =>
  z.number().positive().describe("Цена в рублях (валюта всегда RUR), больше 0.");

/** Hide TTL in hours, capped at 720 (30 days) per the INVALID_TTL error. */
export const ttlInHours = () =>
  z
    .number()
    .int()
    .min(1)
    .max(720)
    .describe("Срок скрытия в часах, максимум 720 (30 дней). Без него предложение скрыто бессрочно.");

/** Payment condition for a special pay-by price (only alongside pay_by_price). */
export const payByCondition = () =>
  z
    .enum(["yandex_pay", "fast_payment_system", "ozon_card"])
    .describe("Условие оплаты для спеццены: yandex_pay, fast_payment_system или ozon_card; только вместе с pay_by_price.");

/** Derives the message `fail` would show — for tools that report errors as data. */
export function errorMessage(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && err.cause instanceof Error) message += ` (${err.cause.message})`;
  return message;
}

/** Wraps a value as a compact-JSON tool result (compact: the consumer is an LLM). */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text: text ?? "null" }] };
}

export function fail(err: unknown): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${errorMessage(err)}` }], isError: true };
}

/**
 * MCP tool annotations — hints the consuming client can use to gate or label a
 * tool. All four hints are set explicitly on every tool: some clients (OpenAI
 * Apps review) require readOnlyHint, destructiveHint and openWorldHint.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * Writes whose repeat may have an additional effect (the API does not document
 * repeat-hide semantics — a new TTL could re-arm the expiry; raw_request can
 * hit anything), so idempotentHint stays false. Nothing this API does is
 * irreversible (hides are undone by show_offers, prices by another update),
 * hence destructiveHint: false.
 */
export const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** State-setting writes (set a price, unhide): replaying converges to the same state. */
export const WRITE_IDEMPOTENT = {
  ...WRITE,
  idempotentHint: true,
} as const;
