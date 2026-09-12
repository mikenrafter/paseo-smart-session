/**
 * The cache-warmth pill: "cached Xm Ys", a countdown to when a resume stops being
 * cheap and starts paying a fresh cache-write cost.
 *
 * Deliberately not gated on provider — every agent with a known last-activity
 * timestamp gets it, using one generic TTL (`shared/cache-window.ts`). Architecture
 * mirrors `client/pill.tsx`'s `AutoCompactPill`/`contributeClient`: a module-level
 * store so every mounted pill redraws together, and a registration per agent that
 * the host's own pressable/border/spinner chrome wraps.
 */

import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";

import { cacheRemainingMs, formatCacheRemaining } from "../shared/cache-window";
import { contextStatus, getSettings } from "../shared/smart-session";

/** How often the client re-reads settings and last-activity, for changes made elsewhere. */
const REFRESH_MS = 20_000;
/** How often the visible countdown itself ticks. */
const TICK_MS = 5_000;

interface CachePillState {
  readonly show: boolean;
  readonly ttlMs: number;
  readonly lastActivityByAgent: ReadonlyMap<string, string>;
}

let state: CachePillState = { show: false, ttlMs: 300_000, lastActivityByAgent: new Map() };
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): CachePillState {
  return state;
}

function publish(next: CachePillState): void {
  state = next;
  for (const listener of listeners) listener();
}

async function refresh(client: PluginClientContext): Promise<void> {
  const [settingsResult, contextResult] = await Promise.all([
    client.rpc(getSettings, {}),
    client.rpc(contextStatus, {}),
  ]);
  const settings = settingsResult?.settings;
  const agents = contextResult?.agents ?? [];
  if (settings === undefined) return; // Malformed or not-yet-ready response: leave the pill as it was.
  publish({
    show: settings.enabled && settings.showCachePill,
    ttlMs: settings.cacheTtlMs,
    lastActivityByAgent: new Map(
      agents
        .filter((agent) => agent.lastActivityAt !== null)
        .map((agent) => [agent.agentId, agent.lastActivityAt as string]),
    ),
  });
}

type LegacyPillProps = PluginHostProps & { workspaceId: string; agentId: string };

export function CacheWarmthPill({ theme, agentId }: LegacyPillProps) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const lastActivityAt = current.lastActivityByAgent.get(agentId);
  if (lastActivityAt === undefined) return null;
  const remaining = cacheRemainingMs(lastActivityAt, current.ttlMs);
  const label = formatCacheRemaining(remaining);
  if (label === "") return null;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name="Snowflake" size={12} color={theme.colors.accent} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
        {`cached ${label}`}
      </Text>
    </View>
  );
}

interface PillRegistration {
  update(patch: { title?: string; label?: string; visible?: boolean; disabled?: boolean }): void;
  remove(): void;
}

type PillHandle = (() => void) | PillRegistration;

function removePill(handle: PillHandle): void {
  if (typeof handle === "function") handle();
  else handle.remove();
}

export function contributeCachePill(client: PluginClientContext): () => void {
  const tracked = new Map<string, { workspaceId: string; handle: PillHandle | null }>();

  function register(agentId: string, entry: { workspaceId: string; handle: PillHandle | null }): void {
    const addComposerPill = client.addComposerPill as unknown as (contribution: {
      id: string;
      workspaceId: string;
      agentId: string;
      button: { title: string; icon: typeof CacheWarmthPill; label: string; behavior: { kind: "display" } };
      title: string;
      Component: typeof CacheWarmthPill;
    }) => PillHandle;
    entry.handle = addComposerPill({
      id: "cache-warmth",
      workspaceId: entry.workspaceId,
      agentId,
      button: { title: "Cache warmth", icon: CacheWarmthPill, label: "Cache", behavior: { kind: "display" } },
      title: "Cache warmth",
      Component: CacheWarmthPill,
    });
  }

  function sync(): void {
    for (const [agentId, entry] of tracked) {
      if (state.show && entry.handle === null) register(agentId, entry);
      else if (!state.show && entry.handle !== null) {
        removePill(entry.handle);
        entry.handle = null;
      }
    }
  }

  function track(agentId: string, workspaceId: string): void {
    const existing = tracked.get(agentId);
    if (existing !== undefined && existing.workspaceId === workspaceId) return;
    if (existing?.handle !== null && existing?.handle !== undefined) removePill(existing.handle);
    tracked.set(agentId, { workspaceId, handle: null });
    sync();
  }

  function forget(agentId: string): void {
    const handle = tracked.get(agentId)?.handle;
    if (handle !== null && handle !== undefined) removePill(handle);
    tracked.delete(agentId);
  }

  const unsubscribeStore = subscribe(sync);
  const unsubscribeAgents = client.paseo.agents.subscribe((update) => {
    if (update.kind === "remove") {
      forget(update.agentId);
      return;
    }
    const { id, workspaceId } = update.agent;
    if (typeof workspaceId !== "string" || workspaceId === "") return;
    track(id, workspaceId);
  });

  void (async () => {
    try {
      const listing = (await client.paseo.agents.list()) as unknown as {
        entries?: readonly { agent?: { id?: string; workspaceId?: string | null } }[];
      };
      for (const entry of listing.entries ?? []) {
        const agent = entry.agent;
        if (typeof agent?.id !== "string" || typeof agent.workspaceId !== "string") continue;
        track(agent.id, agent.workspaceId);
      }
    } catch {
      // Not fatal: the subscription still picks up every agent that speaks next.
    }
  })();

  void refresh(client).catch(() => undefined);
  const timer = setInterval(() => void refresh(client).catch(() => undefined), REFRESH_MS);

  return () => {
    clearInterval(timer);
    unsubscribeAgents();
    unsubscribeStore();
    for (const agentId of [...tracked.keys()]) forget(agentId);
  };
}
