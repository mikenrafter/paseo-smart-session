import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the daemon's plaintext password without reading the bcrypt hash in
 * config.json or putting a secret into an error. The standard Paseo environment
 * wins, then an explicitly configured file, then the paseo-hub VM secret.
 */
export async function resolveDaemonPassword(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env.PASEO_PASSWORD?.trim();
  if (fromEnv) return fromEnv;

  const configuredFile = env.PASEO_PASSWORD_FILE?.trim();
  if (configuredFile) return readPasswordFile(configuredFile, true);

  const home = options.home ?? homedir();
  return readPasswordFile(join(home, "paseo-hub", "secrets", "daemon-password"), false);
}

async function readPasswordFile(path, required) {
  try {
    const password = (await readFile(path, "utf8")).trim();
    if (password !== "") return password;
    if (required) throw new Error("PASEO_PASSWORD_FILE is empty.");
    return undefined;
  } catch (error) {
    if (!required) return undefined;
    if (error instanceof Error && error.message === "PASEO_PASSWORD_FILE is empty.") throw error;
    // Do not echo the filesystem error: it can include secret-bearing paths or
    // platform details and is not useful to an agent that cannot repair them.
    throw new Error("PASEO_PASSWORD_FILE could not be read.");
  }
}
