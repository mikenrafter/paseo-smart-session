/**
 * The smart-compact pill, on every agent's composer.
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
 *
 * Two states, on or off, and pressing it moves between them. There is no third
 * state for "on but nothing will happen", because there is no longer a global
 * switch that can make an enrolled session inert — the master switch hides the pill
 * outright instead.
 */

import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";

import { formatRelative, smartCompactLabel } from "../shared/format";
import { enrolmentState, setEnrolment, type EnrolmentState } from "../shared/governor";
import {
  nextResumeMark,
  resumeMarkLabel,
  resumeMarkState,
  setResumeMarkRpc,
  type AgentResumeState,
} from "../shared/resume";

/** How often the client re-reads enrolment, for changes made somewhere else. */
const REFRESH_MS = 20_000;

/** Pointer dwell before the tooltip opens, so passing over the pill is quiet. */
const HOVER_DELAY_MS = 300;

/**
 * The host's own pill chrome, mirrored from Paseo's `composerPillStyles`:
 * `spacing[3]` and `spacing[1]` of padding inside a 1px border.
 *
 * A plugin renders *inside* that padding, so a hover region left at its natural
 * size answers only over the glyph and stays dead across most of the pill the user
 * is actually pointing at. Cancelling the padding with an equal negative margin
 * grows the region to the pill's edge and leaves the layout exactly where it was —
 * the pill's measured size is unchanged, since the two cancel.
 */
const HOST_PILL_INSET = { horizontal: 13, vertical: 5 };

interface PillState {
  /** Both switches folded into one answer: is there a pill on the composer at all. */
  readonly showPill: boolean;
  readonly enrolled: ReadonlySet<string>;
}

/**
 * Hidden until the daemon says otherwise.
 *
 * The alternative — assume shown, then retract — flashes a pill at everyone who
 * turned it off, every time the app loads.
 */
let state: PillState = { showPill: false, enrolled: new Set() };

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
    // With the feature off there is nothing for a pill to say. Drawing a third,
    // "paused" state would just be a second way of spelling off.
    showPill: next.enabled && next.showPill,
    enrolled: enrolmentSet(next.agents),
  });
}

/**
 * Resume marks and pending ETAs, read into the tooltip alongside enrolment.
 *
 * Kept on the same `listeners` set as the pill store above rather than a second
 * one: both only ever exist to make a mounted pill redraw, and one notification
 * path is simpler than two.
 */
let resumeMarks: ReadonlyMap<string, AgentResumeState> = new Map();

function resumeSnapshot(): ReadonlyMap<string, AgentResumeState> {
  return resumeMarks;
}

function publishResume(next: ReadonlyMap<string, AgentResumeState>): void {
  resumeMarks = next;
  for (const listener of listeners) listener();
}

export async function refreshResumeMarks(
  fetch: () => Promise<{ agents: readonly AgentResumeState[] }>,
): Promise<void> {
  const next = await fetch();
  publishResume(new Map(next.agents.map((agent) => [agent.agentId, agent])));
}

/**
 * Cycles one agent's resume mark, set once `contributeClient` has a live `client`.
 *
 * The tooltip's cycle row lives inside `AutoCompactPill`, which — like the pill
 * itself — is a Component descriptor the host renders; it never receives `client`
 * as a prop. A module-level handler is the same shape as `refreshPills`/
 * `refreshResumeMarks` above: state and the means to change it live in this one
 * client bundle regardless of which pill instance is on screen.
 */
let cycleHandler: ((agentId: string) => Promise<void>) | null = null;

function cycleResumeMark(agentId: string): void {
  void cycleHandler?.(agentId).catch(() => undefined);
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
type LegacyPillProps = PluginHostProps & { workspaceId: string; agentId: string };

/** "Resumes ~14:32 (pre-reset)" / null when nothing is scheduled. */
function pendingResumeLine(resume: AgentResumeState | undefined): string | null {
  if (resume?.pending === null || resume?.pending === undefined) return null;
  const when = resume.pending.scheduledFor === null ? "soon" : formatRelative(resume.pending.scheduledFor);
  return `Resumes ${when} (${resume.pending.mode})`;
}

export function AutoCompactPill({ theme, agentId }: LegacyPillProps) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const resume = useSyncExternalStore(subscribe, resumeSnapshot, resumeSnapshot).get(agentId);
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
  const color = enrolled ? theme.colors.accent : theme.colors.foregroundMuted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        // Stretch plus the cancelled padding is what makes the whole pill hoverable,
        // vertically as well: Paseo's pill is 32px high and this glyph is 14.
        alignSelf: "stretch",
        marginVertical: -HOST_PILL_INSET.vertical,
        marginHorizontal: -HOST_PILL_INSET.horizontal,
        paddingVertical: HOST_PILL_INSET.vertical,
        paddingHorizontal: HOST_PILL_INSET.horizontal,
      }}
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
            {smartCompactLabel({ enrolled })}
          </Text>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {enrolled ? "Press to take this session out" : "Press to enrol this session"}
          </Text>
          {pendingResumeLine(resume) === null ? null : (
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {pendingResumeLine(resume)}
            </Text>
          )}
          <Pressable onPress={() => cycleResumeMark(agentId)} style={{ marginTop: 4 }}>
            <Text numberOfLines={1} style={{ color: theme.colors.accent, fontSize: 11 }}>
              {`Resume: ${resumeMarkLabel(resume?.mark ?? "auto")} (tap to change)`}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The v0.8 button-descriptor icon. The host owns its tooltip and interaction;
 * this component only paints the current state inside the icon slot.
 */
function AutoCompactIcon({
  theme,
  agentId,
  size,
}: PluginHostProps & { agentId: string; size: number; color: string }) {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const color = current.enrolled.has(agentId) ? theme.colors.accent : theme.colors.foregroundMuted;
  return <Icon name="FoldVertical" size={size} color={color} />;
}

/** The lean shape this needs from the agent list, which carries far more. */
interface AgentListing {
  readonly entries?: readonly { readonly agent?: { id?: string; workspaceId?: string | null } }[];
}

/**
 * The published 0.8 descriptor API returns this handle. The 0.8.0-beta.1 npm
 * package and app still return the legacy remover function, so registrations
 * carry both input shapes and this adapter accepts either result. Remove these
 * legacy fields once the beta client and SDK catch up with the deployed docs.
 */
interface PillRegistration {
  update(patch: { title?: string; label?: string; visible?: boolean; disabled?: boolean }): void;
  remove(): void;
}

type PillHandle = (() => void) | PillRegistration;

function removePill(handle: PillHandle): void {
  if (typeof handle === "function") handle();
  else handle.remove();
}

function updatePill(handle: PillHandle, title: string): void {
  if (typeof handle !== "function") handle.update({ title });
}

export function contributeClient(client: PluginClientContext) {
  /** Every agent this app knows of, and its pill registration while one is up. */
  const tracked = new Map<string, { workspaceId: string; handle: PillHandle | null }>();

  function register(agentId: string, entry: { workspaceId: string; handle: PillHandle | null }): void {
    const toggle = async () => {
      const { agent } = await client.rpc(setEnrolment, {
        agentId,
        enrolled: !snapshot().enrolled.has(agentId),
      });
      const enrolled = new Set(snapshot().enrolled);
      if (agent.enrolled) enrolled.add(agent.agentId);
      else enrolled.delete(agent.agentId);
      publish({ ...snapshot(), enrolled });
    };
    const title = smartCompactLabel({ enrolled: snapshot().enrolled.has(agentId) });
    const addComposerPill = client.addComposerPill as unknown as (contribution: {
      id: string;
      workspaceId: string;
      agentId: string;
      button: {
        title: string;
        icon: typeof AutoCompactIcon;
        label: string;
        behavior: { kind: "action"; onPress: () => Promise<void> };
      };
      title: string;
      Component: typeof AutoCompactPill;
      onPress: () => Promise<void>;
    }) => PillHandle;
    entry.handle = addComposerPill({
      id: "smart-compact",
      workspaceId: entry.workspaceId,
      agentId,
      button: {
        title,
        icon: AutoCompactIcon,
        label: "Smart Compact",
        behavior: { kind: "action", onPress: toggle },
      },
      // 0.8.0-beta.1 compatibility; ignored by the documented descriptor host.
      title,
      Component: AutoCompactPill,
      onPress: toggle,
    });
  }

  /** Brings the registrations in line with the store, whichever way it moved. */
  function sync(): void {
    for (const [agentId, entry] of tracked) {
      if (state.showPill && entry.handle === null) register(agentId, entry);
      else if (!state.showPill && entry.handle !== null) {
        removePill(entry.handle);
        entry.handle = null;
      } else if (entry.handle !== null) {
        updatePill(entry.handle, smartCompactLabel({ enrolled: state.enrolled.has(agentId) }));
      }
    }
  }

  function track(agentId: string, workspaceId: string): void {
    const existing = tracked.get(agentId);
    if (existing !== undefined && existing.workspaceId === workspaceId) return;
    // A pill is pinned to one workspace, so an agent that moved needs a new one.
    if (existing?.handle !== null && existing?.handle !== undefined) removePill(existing.handle);
    tracked.set(agentId, { workspaceId, handle: null });
    sync();
  }

  function forget(agentId: string): void {
    const handle = tracked.get(agentId)?.handle;
    if (handle !== null && handle !== undefined) removePill(handle);
    tracked.delete(agentId);
  }

  const refresh = () => refreshPills(() => client.rpc(enrolmentState, {}));
  const refreshResume = () => refreshResumeMarks(() => client.rpc(resumeMarkState, {}));

  cycleHandler = async (agentId: string) => {
    const current = resumeMarks.get(agentId)?.mark ?? "auto";
    await client.rpc(setResumeMarkRpc, { agentId, mark: nextResumeMark(current) });
    await refreshResume();
  };

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
  void refreshResume().catch(() => undefined);
  const timer = setInterval(() => {
    void refresh().catch(() => undefined);
    void refreshResume().catch(() => undefined);
  }, REFRESH_MS);

  return () => {
    clearInterval(timer);
    unsubscribeAgents();
    unsubscribeStore();
    cycleHandler = null;
    for (const agentId of [...tracked.keys()]) forget(agentId);
  };
}
