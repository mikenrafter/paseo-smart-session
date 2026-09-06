/**
 * The auto-compact pill, on every agent's composer.
 *
 * Enrolment is a file on disk, which makes it invisible: there was no way to look
 * at a session and tell whether the governor was watching it. The pill is that
 * answer, in the one place the answer matters — next to the box you are about to
 * type into — and pressing it changes it.
 *
 * State lives in this module rather than in each pill, because the pill and the
 * things that change it (its own press, the Command Center item, the surface
 * toggle) are all in this one client bundle. One store, one fetch, and every
 * mounted pill redraws together.
 */

import { Icon, type PluginClientContext, type PluginComposerPillProps } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";

import { autoCompactLabel } from "./format.shared";
import { enrolmentState, setEnrolment, type EnrolmentState } from "./governor.shared";

/** How often the client re-reads enrolment, for changes made somewhere else. */
const REFRESH_MS = 20_000;

/** Pointer dwell before the tooltip opens, so passing over the pill is quiet. */
const HOVER_DELAY_MS = 300;

interface PillState {
  readonly showPill: boolean;
  readonly autopilot: boolean;
  readonly enrolled: ReadonlySet<string>;
}

/**
 * Hidden until the daemon says otherwise.
 *
 * The alternative — assume shown, then retract — flashes a pill at everyone who
 * turned it off, every time the app loads.
 */
let state: PillState = { showPill: false, autopilot: false, enrolled: new Set() };

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): PillState {
  return state;
}

function publish(next: PillState): void {
  state = next;
  for (const listener of listeners) listener();
}

function enrolmentSet(agents: EnrolmentState["agents"]): ReadonlySet<string> {
  return new Set(agents.filter((agent) => agent.enrolled).map((agent) => agent.agentId));
}

/**
 * Re-reads enrolment and redraws every pill.
 *
 * Takes the call rather than making it: the same fetch is reachable from the client
 * entry, a Command Center item and the surface, and each of those holds a different
 * flavour of RPC caller.
 */
export async function refreshPills(fetch: () => Promise<EnrolmentState>): Promise<void> {
  const next = await fetch();
  publish({
    showPill: next.showPill,
    autopilot: next.autopilot,
    enrolled: enrolmentSet(next.agents),
  });
}

/**
 * One icon, and the words only when you ask for them.
 *
 * The composer track is one line shared with Paseo's own pills, and this one has
 * nothing to say that changes minute to minute — so it states itself in colour and
 * spells it out on hover. Pointer platforms get the tooltip; touch hosts never fire
 * these events and read the colour, or press.
 *
 * Paseo owns the pressable, the border and the spinner; this owns what is in it.
 */
export function AutoCompactPill({ theme, agentId }: PluginComposerPillProps) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [tooltip, setTooltip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoverTimer = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const onPointerEnter = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setTooltip(true);
    }, HOVER_DELAY_MS);
  }, []);

  const onPointerLeave = useCallback(() => {
    clearHoverTimer();
    setTooltip(false);
  }, [clearHoverTimer]);

  const enrolled = current.enrolled.has(agentId);
  const color = !enrolled
    ? theme.colors.foregroundMuted
    : current.autopilot
      ? theme.colors.accent
      : theme.colors.statusWarning;
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <Icon name="FoldVertical" size={14} color={color} />
      {tooltip ? (
        // Drawn above the pill rather than beside it: the track bar is one line
        // high, and widening the pill on hover would shove its neighbours along.
        <View
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: 8,
            gap: 2,
            paddingVertical: 6,
            paddingHorizontal: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface1,
          }}
        >
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {autoCompactLabel({ enrolled, autopilot: current.autopilot })}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {enrolled ? "Press to take this session out" : "Press to enrol this session"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** The lean shape this needs from the agent list, which carries far more. */
interface AgentListing {
  readonly entries?: readonly { readonly agent?: { id?: string; workspaceId?: string | null } }[];
}

export function contributeClient(client: PluginClientContext) {
  /** Every agent this app knows of, and its pill registration while one is up. */
  const tracked = new Map<string, { workspaceId: string; remove: (() => void) | null }>();

  function register(agentId: string, entry: { workspaceId: string; remove: (() => void) | null }): void {
    entry.remove = client.addComposerPill({
      id: "auto-compact",
      title: "Auto-compact",
      workspaceId: entry.workspaceId,
      agentId,
      Component: AutoCompactPill,
      async onPress() {
        const { agent } = await client.rpc(setEnrolment, {
          agentId,
          enrolled: !snapshot().enrolled.has(agentId),
        });
        const enrolled = new Set(snapshot().enrolled);
        if (agent.enrolled) enrolled.add(agent.agentId);
        else enrolled.delete(agent.agentId);
        publish({ ...snapshot(), enrolled });
      },
    });
  }

  /** Brings the registrations in line with the store, whichever way it moved. */
  function sync(): void {
    for (const [agentId, entry] of tracked) {
      if (state.showPill && entry.remove === null) register(agentId, entry);
      else if (!state.showPill && entry.remove !== null) {
        entry.remove();
        entry.remove = null;
      }
    }
  }

  function track(agentId: string, workspaceId: string): void {
    const existing = tracked.get(agentId);
    if (existing !== undefined && existing.workspaceId === workspaceId) return;
    // A pill is pinned to one workspace, so an agent that moved needs a new one.
    existing?.remove?.();
    tracked.set(agentId, { workspaceId, remove: null });
    sync();
  }

  function forget(agentId: string): void {
    tracked.get(agentId)?.remove?.();
    tracked.delete(agentId);
  }

  const refresh = () => refreshPills(() => client.rpc(enrolmentState, {}));

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

  // The subscription only carries agents that report in from now on, and an idle
  // one may not do that for hours.
  void (async () => {
    try {
      const listing = (await client.paseo.agents.list()) as unknown as AgentListing;
      for (const entry of listing.entries ?? []) {
        const agent = entry.agent;
        if (typeof agent?.id !== "string" || typeof agent.workspaceId !== "string") continue;
        track(agent.id, agent.workspaceId);
      }
    } catch {
      // Not fatal: the subscription still picks up every agent that speaks next.
    }
  })();

  void refresh().catch(() => undefined);
  const timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS);

  return () => {
    clearInterval(timer);
    unsubscribeAgents();
    unsubscribeStore();
    for (const agentId of [...tracked.keys()]) forget(agentId);
  };
}
