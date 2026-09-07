/**
 * Reconciling Claude Code's configuration, once, when the plugin loads.
 *
 * A separate module from `install.server.ts` for two reasons, and both of them
 * matter more than the four lines saved by merging them.
 *
 * Paseo compiles `index.ts` twice and deletes the other runtime's *imports and
 * registrations*, keeping every other statement — so calling `install()` from
 * `contribute()`'s shared body would leave a call to a stripped identifier in the
 * client bundle, which throws at load and silently drops every contribution the
 * plugin makes. A side-effect import is removed whole. `check-bundles.mjs` exists
 * for this, and caught exactly this.
 *
 * And it keeps `install.server.ts` free of side effects, so a test can import the
 * reconciler without a module-level call racing it — or worse, writing to the
 * machine's real Claude Code settings just because something imported a function.
 */

import { install } from "./install.server.ts";

void install()
  .then((report) => {
    if (report.error !== null) {
      console.error(`[smart-session] ${report.error}`);
      return;
    }
    if (report.changed) {
      console.log(`[smart-session] registered ${report.hooks.join(", ")} in ${report.settingsPath}`);
    }
    if (report.mcp === "added") console.log("[smart-session] registered the agent-facing MCP server");
    if (report.mcp === "unavailable") {
      console.error(
        "[smart-session] could not reach the `claude` CLI to register the MCP server; run `claude mcp add-json --scope user smart-session` by hand if the agent tools are missing",
      );
    }
  })
  .catch((error: unknown) => console.error("[smart-session] hook install failed", String(error)));
