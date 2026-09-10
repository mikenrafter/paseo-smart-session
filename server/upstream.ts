/**
 * Fetching plan usage from Anthropic directly.
 *
 * Paseo's own reading is honest but bounded: the daemon serves it from a 5-minute
 * cache, `forceRefresh` is not reachable over the wire, and nothing refreshes on a
 * timer — the value only moves when a client happens to ask after the TTL expired.
 * Claude Code's on-disk cache is worse: it only refreshes when a session refreshes
 * it, and has been measured 14 hours behind, understating a weekly window by 7
 * points.
 *
 * Since the whole point of this store is a history that is actually true, it asks
 * upstream itself. Same endpoint, same credentials, same headers Paseo uses — read
 * only, and no more often than a session would ask on its own.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type UpstreamResult =
  | { readonly kind: "ok"; readonly body: unknown }
  | { readonly kind: "needs-auth" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The OAuth access token, from the file Claude Code writes or from the keychain.
 *
 * Read-only in both cases: the Claude CLI owns refreshing this, and a plugin that
 * tried to would race it. The token is never logged, never stored, and never leaves
 * this function's return value.
 */
async function readAccessToken(): Promise<string | null> {
  const home = process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
  try {
    const raw = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: string };
    };
    const token = raw.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token !== "") return token;
  } catch {
    // Expected on machines where the credentials live only in the keychain.
  }

  if (process.platform !== "darwin") return null;

  // The account name varies by how the CLI stored it, so try the specific lookups
  // before the bare one.
  const user = process.env.USER;
  const accounts = [
    ...(user !== undefined && /^[a-zA-Z0-9._-]+$/.test(user) ? [user] : []),
    "claude-code-user",
  ];
  const attempts: string[][] = [
    ...accounts.map((account) => ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"]),
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
  ];

  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync("security", args, { timeout: KEYCHAIN_TIMEOUT_MS });
      const parsed = JSON.parse(stdout.trim()) as { claudeAiOauth?: { accessToken?: string } };
      const token = parsed.claudeAiOauth?.accessToken;
      if (typeof token === "string" && token !== "") return token;
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

/**
 * One usage reading, straight from the source.
 *
 * A 401/403 is reported as `needs-auth` rather than as an error: the credentials
 * expired, which is a thing the user fixes, not a fault worth retrying against.
 */
export async function fetchUpstreamUsage(): Promise<UpstreamResult> {
  const token = await readAccessToken();
  if (token === null) return { kind: "unavailable", reason: "no Claude credentials on this machine" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": OAUTH_BETA,
      },
      signal: controller.signal,
    });
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) return { kind: "needs-auth" };
  if (!response.ok) return { kind: "unavailable", reason: `usage API returned ${response.status}` };

  try {
    return { kind: "ok", body: (await response.json()) as unknown };
  } catch (error) {
    return { kind: "unavailable", reason: `unreadable usage response: ${String(error)}` };
  }
}
