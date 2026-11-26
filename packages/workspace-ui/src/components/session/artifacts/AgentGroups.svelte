<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { ChevronDown as CaretIcon } from "@lucide/svelte";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getSessionSidebarStore, getWorkspaceContext } from "../../../contexts";
  import { requestInputFocus } from "../../../lib/inputFocus";
  import { toasts } from "../../../lib/toasts";
  import { sessionListStore } from "../../../contexts/workspace/session-list.store.svelte";
  import type { SidebarSession } from "../lib/sidebar-rows";
  import { snoozeToastLabel } from "../lib/snooze";
  import type { RailAgentRow } from "../../project-panel/lib/rail-agents";
  import SessionContextMenu from "../SessionContextMenu.svelte";
  import SnoozeTaskMenu from "../SnoozeTaskMenu.svelte";
  import AgentRow from "./AgentRow.svelte";
  import { agentGroups, type AgentGroupKey } from "./lib/overview-view";

  /**
   * The Agents card's rows, grouped by how they stand: Working, Done, Failed,
   * Stopped, and Snoozed last. A group's label folds it. A started session's
   * row takes the sidebar's session menu on right-click, with the row actions
   * the sidebar gives a session (Stop, Done, Snooze, Archive); a sub-agent is
   * no session of its own and has none. Snooze writes the person's session
   * list, as the sidebar's does, so the sidebar's Snoozed shelf and this card
   * agree. An app's Sessions page shows its linked sessions with the same rows.
   */
  interface Props {
    rows: RailAgentRow[];
    /** The host of the session the surface shows: a started session with no host of its own runs there. */
    serverId: string;
    onOpen: (row: RailAgentRow, split: boolean) => void;
  }
  let { rows, serverId, onOpen }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();

  /** When a started session wakes, while it is snoozed. The sidebar's clock moves on at each wake, so a woken row leaves the group on time. */
  function wakesAt(row: RailAgentRow): number | null {
    if (row.kind !== "session") return null;
    const until = sessionListStore.stateFor(row.id)?.snoozedUntil;
    return until && until > sidebarStore.lifecycleNow ? until : null;
  }

  const groups = $derived(agentGroups(rows, (row) => wakesAt(row) !== null));
  const folded = new SvelteSet<AgentGroupKey>();

  let menu = $state<{ row: RailAgentRow; serverId: string; tabId: string | null; x: number; y: number } | null>(null);

  function openMenu(event: MouseEvent, row: RailAgentRow) {
    event.preventDefault();
    event.stopPropagation();
    const rowServerId = row.ref?.serverId ?? serverId;
    menu = { row, serverId: rowServerId, tabId: session.tabIdForHostSession(row.id, rowServerId) ?? null, x: event.clientX, y: event.clientY };
  }

  // The menu runs its action after it closes, so these close over plain values, as the sidebar's do.

  /** An open session stops through its tab, as in the sidebar; one with no tab here stops on its host. */
  function stopAgent(row: RailAgentRow, rowServerId: string, tabId: string | null) {
    if (tabId) session.controls.interruptTabSession(tabId);
    else void serverConnections.apiFor(rowServerId).stopSession(row.id);
  }

  async function completeRow(sessionRow: SidebarSession) {
    try {
      await sidebarStore.completeTask(sessionRow);
    } catch (error) {
      toasts.error("Couldn't complete session", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestInputFocus();
    }
  }

  /** Snooze until a time. The undo toast says it moved before the host answers, as the sidebar's does. */
  function snooze(row: RailAgentRow, rowServerId: string, until: number, note = "") {
    const target = { serverId: rowServerId, sessionId: row.id };
    void sessionListStore.snooze(target, until, note).catch(() => toasts.error("Couldn't snooze it"));
    toasts.undo(snoozeToastLabel({ count: 1, hasNote: !!note, keepsRunning: row.standing === "live" }), () => wake(row, rowServerId));
    requestInputFocus();
  }

  function wake(row: RailAgentRow, rowServerId: string) {
    void sessionListStore.snooze({ serverId: rowServerId, sessionId: row.id }, null).catch(() => toasts.error("Couldn't wake it"));
    requestInputFocus();
  }

  /** The custom time: the sidebar's snooze popover, hung from the point the menu opened at. */
  let customSnooze = $state<{ row: RailAgentRow; serverId: string; x: number; y: number } | null>(null);

  function archiveRow(sessionRow: SidebarSession) {
    sidebarStore.removeRow(sessionRow);
    requestInputFocus();
  }

  function toggle(key: AgentGroupKey) {
    if (folded.has(key)) folded.delete(key);
    else folded.add(key);
  }
</script>

{#each groups as group (group.key)}
  {@const open = !folded.has(group.key)}
  <div class="flex flex-col gap-px pt-1 first:pt-0" data-testid="artifacts-agent-group" data-group={group.key}>
    <button
      type="button"
      aria-expanded={open}
      class="flex h-7 w-fit max-w-full min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-md border-0 bg-transparent px-2 text-xs text-muted-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) pointer-coarse:h-11"
      onclick={() => toggle(group.key)}
    >
      <span class="truncate">{group.label} · <span class="tabular-nums">{group.rows.length}</span></span>
      <CaretIcon size={12} class="shrink-0 transition-transform duration-(--duration-base) ease-(--ease-premium) motion-reduce:transition-none {open ? '' : '-rotate-90'}" />
    </button>
    {#if open}
      {#each group.rows as row (row.key)}
        <AgentRow
          {row}
          onOpen={(split) => onOpen(row, split)}
          onContextMenu={row.kind === "session" && !row.pending ? (event) => openMenu(event, row) : undefined}
          wakesAt={group.key === "snoozed" ? wakesAt(row) : null}
          onWake={() => wake(row, row.ref?.serverId ?? serverId)}
        />
      {/each}
    {/if}
  </div>
{/each}

{#if menu}
  {@const target = menu}
  <!-- Done and Archive belong to the session's own sidebar row, so they show only while it has one. -->
  {@const sessionRow = target.tabId ? sidebarStore.rowForTab(target.tabId) : null}
  <SessionContextMenu
    x={target.x}
    y={target.y}
    tabId={target.tabId}
    sessionId={target.row.id}
    serverId={target.serverId}
    showSplit
    onOpenInSplit={() => onOpen(target.row, true)}
    rowActions={{
      onStop: target.row.standing === "live" ? () => stopAgent(target.row, target.serverId, target.tabId) : undefined,
      done: sessionRow?.status === "done",
      onToggleDone: sessionRow ? () => void completeRow(sessionRow) : undefined,
      onSnooze:
        wakesAt(target.row) === null
          ? (until?: number) => {
              if (until !== undefined) snooze(target.row, target.serverId, until);
              else customSnooze = { row: target.row, serverId: target.serverId, x: target.x, y: target.y };
            }
          : undefined,
      onArchive: sessionRow && sidebarStore.canArchive(sessionRow) ? () => archiveRow(sessionRow) : undefined,
    }}
    onClose={() => (menu = null)}
  />
{/if}

{#if customSnooze}
  {@const target = customSnooze}
  <SnoozeTaskMenu
    customTime
    anchor={{ x: target.x, y: target.y }}
    taskTitle={target.row.title}
    onConfirm={(until, note) => {
      customSnooze = null;
      snooze(target.row, target.serverId, until, note);
    }}
    onClose={() => {
      customSnooze = null;
      requestInputFocus();
    }}
  />
{/if}
