<script lang="ts">
  import { Bot as BotIcon, ChevronRight as ChevronRightIcon, CornerLeftUp as ParentIcon, GitFork as ForkIcon, Plus as PlusIcon, Square as SquareIcon } from "@lucide/svelte";
  import type { SessionTreeRelation } from "@solus/contracts/session-digest";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { knownRunnerFor } from "@solus/client-core/session-runner";
  import { uuid } from "@solus/contracts/uuid";
  import { isInScope } from "@solus/client-core/session-overview";
  import type { TurnSpan } from "@solus/client-core/session-artifact-chips";
  import { getWorkspaceContext, serversStore } from "../../contexts";
  import { SvelteSet } from "svelte/reactivity";
  import { sessionTreeStore } from "../../contexts/sessions/session-tree.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { toasts } from "../../lib/toasts";
  import * as TooltipUI from "../ui/tooltip";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import { openAgentSession } from "../conversation/agent-conversation/lib/agent-conversation";
  import PanelSection from "./PanelSection.svelte";
  import LineageWorkflow from "./LineageWorkflow.svelte";
  import ArtifactCard from "../session/artifacts/ArtifactCard.svelte";
  import {
    formatCompactElapsed,
    treeAgentRows,
    railAgentTooltip,
    RAIL_AGENTS_INITIAL_COUNT,
    RAIL_AGENTS_PAGE_COUNT,
    type TreeAgentRow,
  } from "./lib/rail-agents";
  import { isPanelItemShown } from "./lib/panel-items";

  interface Props {
    tabId?: string;
    sessionId: string;
    serverId: string;
    active: boolean;
    collapsed?: boolean;
    onToggle?: () => void;
    onResizePointerDown?: (event: PointerEvent) => void;
    hiddenItems?: readonly string[];
    surface?: "rail" | "threads";
    query?: string;
    turnWindow?: TurnSpan | null;
  }
  let {
    tabId, sessionId, serverId, active, collapsed = false, onToggle, onResizePointerDown,
    hiddenItems = [], surface = "rail", query = "", turnWindow = null,
  }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;
  $effect(() => {
    if (active) return sessionTreeStore.retain(serverId, sessionId);
  });
  const view = $derived(active ? sessionTreeStore.viewFor(sessionId, serverId) : null);
  const search = $derived(query.trim().toLowerCase());
  const rows = $derived(treeAgentRows(view?.tree ?? null, sessionId, serverId).filter((row) =>
    row.title.toLowerCase().includes(search) && isInScope(turnWindow, row.startedAt),
  ));
  const relations = $derived((view?.tree?.relations ?? []).filter((row) => row.title.toLowerCase().includes(search)));
  const canMerge = $derived(!view?.stale && view?.tree?.nodes[0]?.digest?.turns.some((turn) =>
    turn.settled && (turn.outcome === undefined || turn.outcome === "completed"),
  ) === true);
  const ownsConversation = $derived(!view?.tree?.nodes[0]?.record.runnerHostId);
  const running = $derived(isPanelItemShown(hiddenItems, "agents.running") ? rows.filter((row) => row.tone === "live") : []);
  const previous = $derived(isPanelItemShown(hiddenItems, "agents.previous") ? rows.filter((row) => row.tone !== "live") : []);
  const failedCount = $derived(previous.filter((row) => row.tone === "failed").length);
  const header = $derived(running.length > 0
    ? `${running.length} running`
    : previous.length > 0 ? `${previous.length} previous` : "");

  let now = $state(Date.now());
  const hasLive = $derived(running.length > 0);
  $effect(() => {
    if (!hasLive || collapsed) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  let previousOpen = $state(false);
  let activeCount = $state(RAIL_AGENTS_INITIAL_COUNT);
  let previousCount = $state(RAIL_AGENTS_INITIAL_COUNT);
  let merging = $state(false);
  const stopping = new SvelteSet<string>();

  const openSubagent = $derived(router.companionSurface?.name === "subagent" ? router.companionSurface.params : null);

  function runnerServerId(hostId: string): string {
    return knownRunnerFor(hostId, serversStore.knownHosts) ?? serverConnections.resolveId(hostId);
  }

  async function open(row: TreeAgentRow, split: boolean) {
    if (row.kind === "subagent") {
      router.navigate({ name: "subagent", params: { sessionId, toolId: row.id, serverId } });
      requestInputFocus({ tabId });
      return;
    }
    const runner = runnerServerId(row.serverId);
    if (row.isRemote && serverConnections.readinessFor(runner).readiness !== "ready") {
      router.navigate({ name: "sessionRecord", params: { sessionId: row.id, serverId, viaParentId: sessionId } }, { target: "companion" });
      return;
    }
    try {
      await openAgentSession(
        { sessionId: row.id, cwd: row.cwd },
        row.provider,
        runner,
        {
          resume: (resumed, opts) => session.opening.resumeSession(resumed, opts),
          openInSplit: (openedTabId) => session.openTabAsSurface(openedTabId),
        },
        { split },
      );
    } catch (error) {
      toasts.error("Could not open agent", { description: String(error) });
    }
  }

  async function stop(row: TreeAgentRow) {
    if (stopping.has(row.key)) return;
    stopping.add(row.key);
    requestInputFocus({ tabId });
    try {
      const stopped = row.kind === "session"
        ? await serverConnections.apiFor(runnerServerId(row.serverId)).stopSession(row.id)
        : await serverConnections.apiFor(serverId).stopSessionSubagent(sessionId, row.id);
      if (!stopped) {
        toasts.error("The agent is no longer running");
      }
    } catch (error) {
      toasts.error("Could not stop agent", { description: String(error) });
    } finally {
      stopping.delete(row.key);
    }
  }

  async function openRelation(relation: SessionTreeRelation) {
    try {
      const candidates = relation.hostLabel ? serversStore.knownHosts.filter((host) => host.label === relation.hostLabel) : [];
      const hostId = relation.hostLabel ? (candidates.length === 1 ? candidates[0]?.id : null) : runnerServerId(relation.runnerHostId ?? serverId);
      if (!hostId) throw new Error("Connect to the host that started this session.");
      const targetTabId = await session.revealSession(relation.sessionId, hostId);
      if (!targetTabId) throw new Error("The related session is unavailable on its host.");
    } catch (error) {
      toasts.error("Could not open related session", { description: String(error) });
    }
  }

  async function mergeBack() {
    if (merging) return;
    merging = true;
    try {
      const { target, prompt } = await serverConnections.apiFor(serverId).sessionMergeBackPrompt(sessionId);
      const result = await serverConnections.apiFor(runnerServerId(target.runnerHostId ?? serverId)).promptHeadlessSession({
        sessionId: target.sessionId, prompt, promptId: uuid(), delivery: "queue",
      });
      toasts.success(result.disposition === "queued" ? "Merge back queued" : "Merge back sent");
      await openRelation(target);
    } catch (error) {
      toasts.error("Could not merge back", { description: String(error) });
    } finally {
      merging = false;
    }
  }

  function togglePrevious() {
    previousOpen = !previousOpen;
    requestInputFocus({ tabId });
  }

  function retry() {
    sessionTreeStore.reload(sessionId, serverId);
    requestInputFocus({ tabId });
  }
</script>

{#if rows.length > 0 || relations.length > 0 || view?.stale}
  {#if surface === "threads"}
    <ArtifactCard icon={BotIcon} title="Agents" count={rows.length + relations.length}>
      {@render content()}
    </ArtifactCard>
  {:else if onToggle}
    <PanelSection title="Agents" headerDetail={header} {collapsed} {onToggle} {onResizePointerDown}>
      {@render content()}
    </PanelSection>
  {/if}
{/if}

{#snippet content()}
    {#if view?.stale}
      <div class="flex items-baseline justify-between gap-2 px-2.5 py-1 text-chrome-dense text-(--solus-text-tertiary)">
        <span>{view.tree ? "Agent status may be out of date." : "Could not load agents."}</span>
        <button type="button" class="cursor-pointer underline" onclick={retry}>Retry</button>
      </div>
    {/if}
    {#each relations as relation (relation.sessionId)}
      <div class="flex min-h-8 items-center gap-1 rounded-lg px-2">
        <button type="button" class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-ring" onclick={() => void openRelation(relation)}>
          {#if relation.kind === "parent"}
            <ParentIcon size={16} class="shrink-0" aria-hidden="true" />
          {:else}
            <ForkIcon size={16} class="shrink-0" aria-hidden="true" />
          {/if}
          <span class="min-w-0 truncate text-[13px] pointer-coarse:text-workspace-chrome" title={relation.title}>{relation.title}</span>
          <span class="shrink-0 text-chrome-dense text-(--solus-text-tertiary)">{relation.kind === "parent" ? "Parent" : relation.kind === "fork-source" ? "Fork source" : "Fork"}</span>
        </button>
        {#if relation.kind === "fork-source"}
          <button type="button" class="shrink-0 rounded-md px-1.5 py-1 text-chrome-dense hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" disabled={!canMerge || merging} title="Send the fork’s findings to the source conversation" onclick={() => void mergeBack()}>
            {merging ? "Sending…" : "Merge back"}
          </button>
        {/if}
      </div>
    {/each}
    {#if hasLive}
      {@render rowList(running, activeCount, () => (activeCount += RAIL_AGENTS_PAGE_COUNT))}
    {/if}
    {#if previous.length > 0}
      {#if hasLive}
        <button
          type="button"
          class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg px-2.5 text-left text-chrome-dense font-medium text-(--solus-text-tertiary) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring"
          aria-expanded={previousOpen}
          data-testid="rail-agents-previous"
          onclick={togglePrevious}
        >
          <ChevronRightIcon size={14} aria-hidden="true" class="shrink-0 {previousOpen ? 'rotate-90' : ''}" />
          <span class="min-w-0 flex-1 truncate">Previous agents{previousOpen ? "" : ` (${previous.length})`}</span>
          {#if failedCount > 0}
            <span class="shrink-0 text-(--solus-status-error)">{failedCount} failed</span>
          {/if}
        </button>
      {/if}
      {#if !hasLive || previousOpen}
        {@render rowList(previous, previousCount, () => (previousCount += RAIL_AGENTS_PAGE_COUNT))}
      {/if}
    {:else if !hasLive && rows.length > 0}
      <p class="m-0 px-2.5 py-1 text-chrome-dense text-(--solus-text-tertiary)">
        {isPanelItemShown(hiddenItems, "agents.previous") ? "No previous agents." : "No running agents."}
      </p>
    {/if}
{/snippet}

{#snippet rowList(rows: TreeAgentRow[], visibleCount: number, showMore: () => void)}
  <!-- Bounded so a long fan-out cannot push the rest of the rail off screen. -->
  <ul
    class="scrollbar-on-hover m-0 flex max-h-[13.5rem] list-none flex-col gap-px overflow-y-auto overscroll-contain p-0"
  >
    {#each rows.slice(0, visibleCount) as row (row.key)}
      <li>
        {@render agentRow(row)}
        {#if row.kind === "subagent" && row.workflow}
          <LineageWorkflow workflow={row.workflow} halted={row.tone === "idle" || row.tone === "failed"} />
        {/if}
      </li>
    {/each}
  </ul>
  {#if rows.length > visibleCount}
    <button
      type="button"
      class="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-chrome-dense text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
      onclick={showMore}
    >
      <PlusIcon size={16} aria-hidden="true" class="shrink-0" />
      Show {Math.min(rows.length - visibleCount, RAIL_AGENTS_PAGE_COUNT)} more
    </button>
  {/if}
{/snippet}

{#snippet agentRow(row: TreeAgentRow)}
  {@const isOpen = row.kind === "subagent" && openSubagent?.sessionId === sessionId && openSubagent.toolId === row.id}
  {@const canStop = row.tone === "live" && !view?.stale && (row.kind === "session"
    ? !row.isRemote || serversStore.readinessFor(runnerServerId(row.serverId)).readiness === "ready"
    : ownsConversation && row.canStop)}
  {@const mark = row.provider === "codex" ? "codex" : row.provider === "claude-code" ? "claude" : null}
  {@const elapsedMs = (row.endedAt ?? now) - row.startedAt}
  {@const hostLabel = row.kind === "session" && row.isRemote ? serversStore.hostFor(runnerServerId(row.serverId))?.label ?? "Remote host" : null}
  <div class="group relative flex h-8 items-center">
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            type="button"
            class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-2.5 text-left transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none disabled:cursor-default {isOpen
              ? 'bg-(--solus-surface-hover)'
              : ''}"
            aria-label="{row.title}, {row.status}"
            aria-current={isOpen ? "true" : undefined}
            data-testid="rail-agent-row"
            data-kind={row.kind}
            data-state={row.tone}
            onclick={(e) => open(row, e.metaKey || e.ctrlKey)}
          >
            <!-- The provider's mark, and a status dot on its corner. -->
            <span class="relative inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
              {#if mark}
                <ProviderMark {mark} size={mark === "codex" ? 10 : 14} transparent />
              {:else}
                <BotIcon size={16} class="text-(--solus-text-tertiary)" />
              {/if}
              <span
                class="absolute -right-1 -bottom-1 size-2 rounded-full border-2 border-(--solus-container-bg) {row.tone ===
                'live'
                  ? 'bg-(--solus-status-running)'
                  : row.tone === 'done'
                    ? 'bg-(--solus-status-complete)'
                    : row.tone === 'failed'
                      ? 'bg-(--solus-status-error)'
                      : 'bg-[color-mix(in_srgb,var(--solus-text-tertiary)_45%,transparent)]'}"
              ></span>
            </span>
            <span
              class="min-w-0 flex-1 truncate text-[13px] pointer-coarse:text-workspace-chrome text-[color-mix(in_srgb,var(--solus-text-primary)_85%,transparent)]"
              >{row.title}</span
            >
            {#if hostLabel}
              <span class="max-w-1/3 shrink-0 truncate text-chrome-dense text-(--solus-text-tertiary)" title={hostLabel}>{hostLabel}</span>
            {/if}
            <span
              class="shrink-0 whitespace-nowrap text-chrome-dense tabular-nums {row.tone === 'failed'
                ? 'text-(--solus-status-error)'
                : 'text-(--solus-text-tertiary)'} {canStop
                ? 'group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:opacity-0'
                : ''}"
              >{row.tone === "failed" || row.tone === "idle" || elapsedMs <= 0
                ? row.status
                : formatCompactElapsed(elapsedMs)}</span
            >
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={railAgentTooltip(row.title, row.status, row.detail)} />
    </TooltipUI.Root>
    {#if canStop}
      <!-- Stop shows in place of the time on hover; on touch it always shows. -->
      <button
        type="button"
        class="pointer-events-none absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) opacity-0 transition-[opacity,color,background-color] duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-status-error) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        disabled={stopping.has(row.key)}
        aria-label={stopping.has(row.key) ? `Stopping ${row.title}` : `Stop ${row.title}`}
        title="Stop agent"
        data-testid="rail-agent-stop"
        onclick={() => stop(row)}
      >
        <SquareIcon size={12} class="fill-current" aria-hidden="true" />
      </button>
    {/if}
  </div>
{/snippet}
