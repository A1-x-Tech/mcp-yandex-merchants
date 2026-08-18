import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Directory name under $XDG_CONFIG_HOME (or ~/.config). */
const APP = "mcp-yandex-merchants";

/**
 * Tokens minted by the in-chat login flow. Written by `finish_login`, read on
 * every API call — the file is the reason a fresh token takes effect without
 * restarting the client: nothing is cached in the process beyond one request.
 */
export interface StoredCredentials {
  access_token: string;
  /** Present for the PKCE flow; absent for a token pasted in by hand. */
  refresh_token?: string;
  /** Epoch ms after which the access token is no longer valid. */
  expires_at?: number;
  /** Epoch ms the token was obtained — shown in auth_status, never sent anywhere. */
  obtained_at: number;
}

/** Absolute path of the credentials file; safe to show the user. */
export function credentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, APP, "credentials.json");
}

/** Reads stored credentials, or undefined when nothing is stored (or it is unreadable). */
export function readCredentials(): StoredCredentials | undefined {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as StoredCredentials;
    // A truncated or hand-edited file must not read as "logged in": without a
    // usable access_token the caller has to fall through to the login flow.
    if (typeof parsed?.access_token !== "string" || parsed.access_token === "") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Writes credentials with owner-only permissions, atomically. The content goes
 * to a temp file in the same directory (same filesystem — that is what keeps
 * the rename atomic) and lands on credentials.json via renameSync: a crash
 * mid-write can never leave a truncated file, which would read as "not
 * connected" and silently drop the login. The 0600 mode is set when the temp
 * file is opened, so the token bytes never exist under a wider mode, and the
 * rename carries the mode over — no chmod-after needed.
 */
export function writeCredentials(credentials: StoredCredentials): string {
  const file = credentialsPath();
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.credentials.json.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return file;
}

/** Deletes the credentials file. Returns true when a file was actually removed. */
export function clearCredentials(): boolean {
  const file = credentialsPath();
  if (!readCredentials() && !fileExists(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
