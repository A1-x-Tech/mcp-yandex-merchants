import { ConfigError, loadConfig } from "./config.js";
import { MerchantsClient } from "./client.js";

/** Live READ-ONLY smoke check: lists the feeds available to the token. */
async function main(): Promise<void> {
  const client = new MerchantsClient(loadConfig());
  const result = await client.feedsInfo();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // A missing token is a user error, not a bug: report it without the stack.
  console.error("smoke failed:", err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
