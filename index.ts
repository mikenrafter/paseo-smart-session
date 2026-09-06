import type { PluginContext } from "@getpaseo/plugin";

import { readAgents, withDaemon } from "./daemon.server.ts";
import { lifecycle } from "./lifecycle.shared.ts";
import { newestUsage, readUsage, dataDir } from "./store.server.ts";
import { contextGrowth, projectFull } from "./growth.server.ts";
import { countEnrolled, listEnrolment, readSettings, setEnrolled, writeSettings } from "./settings.server.ts";
import { profileFor } from "./thresholds.shared.ts";
import { summarizeSpend } from "./spend.server.ts";
import { budgetStatus, contextStatus, getSettings, setSettings, spendSummary } from "./smart-session.shared.ts";
import {
  cancelCompaction,
  enrolmentState,
  listCompactions,
  requestCompaction,
  setEnrolment,
} from "./governor.shared.ts";
import { segmentBlocks, burnRatePctPerHour, projectedExhaustion } from "./blocks.shared.ts";
import { effectiveAt } from "./usage.shared.ts";
import { SmartSessionSurface } from "./surface.client";
import { contributeClient, refreshPills } from "./pill.client";

// Importing the recorder for its side effect: it starts on load and records
// whether or not anything is looking at it. See recorder.server.ts.
import "./recorder.server.ts";
// Same: the governor owns the compaction queue and its delivery timer.
import { queue } from "./governor.server.ts";

export default function contribute(plugin: PluginContext) {
  plugin.handle(budgetStatus, async () => {
    try {
      const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
      const samples = await readUsage({ sinceMs: since });
      const newest = await newestUsage();

      // One row per window, taken from its currently open block.
      const open = new Map<string, ReturnType<typeof segmentBlocks>[number]>();
      for (const block of segmentBlocks(samples)) open.set(block.windowId, block);

      const windows = [...open.values()]
        .map((block) => ({
          id: block.windowId,
          pct: block.finalPct,
          resetsAt: block.resetsAt,
          burnPctPerHour: burnRatePctPerHour(block),
          projectedFullAt: projectedExhaustion(block),
        }))
        .sort((a, b) => b.pct - a.pct);

      const newestInstant = newest === null ? null : effectiveAt(newest);
      return {
        windows,
        recorder: {
          newestAt: newestInstant,
          ageSeconds:
            newestInstant === null ? null : Math.round((Date.now() - Date.parse(newestInstant)) / 1000),
          source: newest?.src ?? null,
          samplesHeld: samples.length,
          firstSampleAt: samples.length === 0 ? null : effectiveAt(samples[0]!),
          dataDir: dataDir(),
        },
        error: null,
      };
    } catch (error) {
      return {
        windows: [],
        recorder: {
          newestAt: null,
          ageSeconds: null,
          source: null,
          samplesHeld: 0,
          firstSampleAt: null,
          dataDir: dataDir(),
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  plugin.handle(contextStatus, async ({ agentId }) => {
    try {
      const rows = await withDaemon((client) => readAgents(client));
      const growth = await contextGrowth();
      const { thresholds } = await readSettings();
      const agents = rows
        .filter((row) => agentId === undefined || row.id === agentId)
        .filter((row) => row.usedTokens !== null && row.maxTokens !== null && row.maxTokens > 0)
        .map((row) => ({
          agentId: row.id,
          title: row.title,
          provider: row.provider,
          model: row.model,
          status: row.status,
          usedTokens: row.usedTokens!,
          maxTokens: row.maxTokens!,
          usedPct: Math.round((row.usedTokens! / row.maxTokens!) * 1000) / 10,
          costUsd: row.costUsd,
          growthTokensPerHour: growth.get(row.id) ?? null,
          projectedFullAt: projectFull(row.usedTokens!, row.maxTokens!, growth.get(row.id) ?? null, thresholds),
          compactAtPct: profileFor(row.maxTokens!, thresholds).compact,
        }))
        .sort((a, b) => b.usedPct - a.usedPct);
      return { agents, error: null };
    } catch (error) {
      return { agents: [], error: error instanceof Error ? error.message : String(error) };
    }
  });

  plugin.handle(spendSummary, async ({ days }) => {
    try {
      return { summary: await summarizeSpend({ days }), error: null };
    } catch (error) {
      return {
        summary: {
          byDay: [], heatmap: [], byProject: [], byModel: [],
          totalTokens: 0, subagentTokens: 0, cacheHitPct: 0,
          firstHour: null, lastHour: null, bucketCount: 0,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  plugin.handle(getSettings, async () => ({
    settings: await readSettings(),
    enrolledAgents: await countEnrolled(),
  }));

  plugin.handle(setSettings, async (patch) => ({ settings: await writeSettings(patch) }));

  plugin.handle(requestCompaction, async ({ agentId, reason, statePath }) => ({
    request: await queue.add({ agentId, reason, statePath: statePath ?? null }),
  }));

  plugin.handle(listCompactions, async ({ agentId }) => {
    const items = await queue.list();
    return {
      items: (agentId === undefined ? items : items.filter((item) => item.agentId === agentId)).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      ),
    };
  });

  plugin.handle(cancelCompaction, async ({ id }) => {
    const updated = await queue.update(id, {
      state: "cancelled",
      settledAt: new Date().toISOString(),
    });
    return { ok: updated !== null };
  });

  plugin.handle(enrolmentState, async () => {
    const settings = await readSettings();
    return { showPill: settings.showPill, autopilot: settings.autopilot, agents: await listEnrolment() };
  });

  plugin.handle(setEnrolment, async ({ agentId, enrolled }) => ({
    agent: await setEnrolled(agentId, enrolled),
  }));

  plugin.addSurface("overview", SmartSessionSurface);
  plugin.addSidebarItem({
    id: "smart-session",
    title: "Smart Session",
    icon: "Gauge",
    surface: "overview",
  });

  plugin.addClientSide(contributeClient);

  plugin.addCommandCenterItem({
    id: "smart-session-open",
    title: "Show plan usage and agent context",
    icon: "Gauge",
    keywords: ["usage", "budget", "limit", "context", "tokens", "compact"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("overview");
    },
  });

  plugin.addCommandCenterItem({
    id: "smart-session-pill",
    title: "Show or hide the smart-compact pill",
    icon: "ToggleLeft",
    keywords: ["pill", "compact", "autopilot", "governor", "enrol"],
    context: "global",
    async onSelect({ rpc }) {
      const { settings } = await rpc(getSettings, {});
      await rpc(setSettings, { showPill: !settings.showPill });
      await refreshPills(() => rpc(enrolmentState, {}));
    },
  });

  // Releases the recorder through a shared object rather than by naming
  // recorder.server: Paseo strips server imports from the client bundle but keeps
  // the surrounding code, so a server identifier here would break every
  // contribution. Skipping this stops Paseo's teardown from ever completing.
  return async () => {
    const teardowns = lifecycle.teardowns.splice(0);
    for (const teardown of teardowns) await teardown();
  };
}
