<script lang="ts">
  import {
    Bot as BotIcon,
    ChevronRight as ChevronRightIcon,
    Plus as PlusIcon,
    Square as SquareIcon,
  } from "@lucide/svelte";
  import type { Message } from "@solus/contracts/types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { liveActivityClock } from "../../lib/shared-clock";
  import * as TooltipUI from "../ui/tooltip";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import { agentConversationMeta } from "../conversation/agent-conversation/agent-conversation-meta.store.svelte";
  import {
    hostLabelFor,
    openAgentSession,
  } from "../conversation/agent-conversation/lib/agent-conversation";
  import PanelSection from "./PanelSection.svelte";
  import {
    formatCompactElapsed,
    railAgentList,
    RAIL_AGENTS_INITIAL_COUNT,
    RAIL_AGENTS_PAGE_COUNT,
    type RailAgentRow,
  } from "./lib/rail-agents";
  import { runHost } from "../../contexts/workspace/run-location";

  /**
   * Every agent the session dispatched, as one card (T3 Code's Lineage
   * panel): its sub-agents and the Solus sessions it started. Live agents
   * show, and settled ones fold under "Previous agents" while any run. A sub-agent row opens
   * the sub-agent pane; a session row opens that session.
   */
  interface Props {
    /** The conversation whose agents these are. */
    tabId: string;
    /** The agent messages, already filtered by the rail. */
    messages: Message[];
    collapsed: boolean;
    onToggle: () => void;
    onResizePointerDown?: (event: PointerEvent) => void;
  }
  let { tabId, messages, collapsed, onToggle, onResizePointerDown }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;
  const currentSession = $derived(session.sessionFor(tabId));
  // A started session lives on this tab's host unless its card names another.
  const api = $derived(session.apiFor(tabId));
  const serverId = $derived(runHost(currentSession?.run));

  // Keep the index's record of each started session (its slug title and
  // provider) while the card lists it. A string key of `sessionId host`, so
  // the retains are only remade when the set of sessions changes.
  const sessionIdsKey = $derived(
    [
      ...new Set(
        messages.flatMap((message) => {
          const ref = message.agentConversationRef;
          return ref && !ref.starting ? [`${ref.sessionId} ${ref.serverId ?? ""}`] : [];
        }),
      ),
    ].join("\n"),
  );
  $effect(() => {
    if (!sessionIdsKey) return;
    const releases = sessionIdsKey
      .split("\n")
      .map((key) => {
        const [sessionId, sessionServerId] = key.split(" ");
        return sessionServerId
          ? agentConversationMeta.retain(sessionId, serverConnections.apiFor(sessionServerId), sessionServerId)
          : agentConversationMeta.retain(sessionId, api, serverId);
      });
    return () => releases.forEach((release) => release());
  });

  let now = $state(Date.now());
  const list = $derived(
    railAgentList(messages, now, {
      fallback: {
        model: (
          currentSession?.sessionModel ||
          currentSession?.run.modelConfig.modelId ||
          ""
        ).trim(),
        effort: (currentSession?.run.modelConfig.reasoningEffort || "").trim(),
      },
      metaFor: (sessionId) => agentConversationMeta.metaFor(sessionId),
      hostLabel: hostLabelFor(serverId),
    }),
  );
  // A boolean, so the clock subscription is not remade on every tick.
  const hasLive = $derived(list.active.length > 0);
  $effect(() => {
    if (!hasLive || collapsed) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  let previousOpen = $state(false);
  let activeCount = $state(RAIL_AGENTS_INITIAL_COUNT);
  let previousCount = $state(RAIL_AGENTS_INITIAL_COUNT);
  const previousFailed = $derived(
    list.previous.filter((row) => row.tone === "failed").length,
  );

  const openSubagentId = $derived(
    router.companionSurface?.name === "subagent" ? router.companionSurface.params.messageId : null,
  );

  function open(row: RailAgentRow, split = false) {
    if (row.kind === "subagent") {
      session.openSubagent(tabId, row.id);
      requestInputFocus({ tabId });
      return;
    }
    if (!row.ref || row.pending) return;
    void openAgentSession(
      row.ref,
      row.provider,
      row.ref.serverId ?? serverId,
      {
        resume: (resumed, opts) => session.opening.resumeSession(resumed, opts),
        openInSplit: (openedTabId) => session.openTabAsSurface(openedTabId),
      },
      { split },
    );
  }

  function stop(row: RailAgentRow) {
    void api.stopSession(row.id);
    requestInputFocus({ tabId });
  }

  function togglePrevious() {
    previousOpen = !previousOpen;
    requestInputFocus({ tabId });
  }
</script>

<PanelSection
  title="Agents"
  headerDetail={list.detail}
  {collapsed}
  {onToggle}
  {onResizePointerDown}
>
  {#if list.active.length > 0}
    {@render rowList(list.active, activeCount, () => (activeCount += RAIL_AGENTS_PAGE_COUNT))}
  {/if}
  {#if list.active.length === 0}
    <!-- Nothing runs: the settled agents are the whole lineage, so they show
         without a fold. -->
    {@render rowList(list.previous, previousCount, () => (previousCount += RAIL_AGENTS_PAGE_COUNT))}
  {:else if list.previous.length > 0}
    <button
      type="button"
      class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg px-2.5 text-left text-chrome-dense font-medium text-(--solus-text-tertiary) transition-colors duration-150 hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
      aria-expanded={previousOpen}
      data-testid="rail-agents-previous"
      onclick={togglePrevious}
    >
      <ChevronRightIcon
        size={14}
        aria-hidden="true"
        class="shrink-0 transition-transform duration-150 {previousOpen ? 'rotate-90' : ''}"
      />
      <span class="min-w-0 flex-1 truncate"
        >Previous agents{previousOpen ? "" : ` (${list.previous.length})`}</span
      >
      {#if previousFailed > 0}
        <span class="shrink-0 font-normal text-(--solus-status-error)">{previousFailed} failed</span>
      {/if}
    </button>
    {#if previousOpen}
      {@render rowList(list.previous, previousCount, () => (previousCount += RAIL_AGENTS_PAGE_COUNT))}
    {/if}
  {/if}
</PanelSection>

{#snippet rowList(rows: RailAgentRow[], visibleCount: number, showMore: () => void)}
  <!-- Bounded so a long fan-out cannot push the rest of the rail off screen. -->
  <ul
    class="scrollbar-on-hover m-0 flex max-h-[13.5rem] list-none flex-col gap-px overflow-y-auto overscroll-contain p-0"
  >
    {#each rows.slice(0, visibleCount) as row (row.key)}
      {@render agentRow(row)}
    {/each}
  </ul>
  {#if rows.length > visibleCount}
    <button
      type="button"
      class="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left font-medium text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
      onclick={showMore}
    >
      <PlusIcon size={16} aria-hidden="true" class="shrink-0" />
      Show {Math.min(rows.length - visibleCount, RAIL_AGENTS_PAGE_COUNT)} more
    </button>
  {/if}
{/snippet}

{#snippet agentRow(row: RailAgentRow)}
  {@const isOpen = row.kind === "subagent" && openSubagentId === row.id}
  {@const canStop = row.kind === "session" && row.tone === "live" && !row.pending}
  {@const mark = row.provider === "codex" ? "codex" : row.provider === "claude-code" ? "claude" : null}
  <li class="group relative flex h-8 items-center">
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
            disabled={row.kind === "session" && row.pending}
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
              class="min-w-0 flex-1 truncate font-medium text-[color-mix(in_srgb,var(--solus-text-primary)_85%,transparent)]"
              >{row.title}</span
            >
            <span
              class="shrink-0 whitespace-nowrap text-chrome-dense tabular-nums {row.tone === 'failed'
                ? 'text-(--solus-status-error)'
                : 'text-(--solus-text-tertiary)'} {canStop
                ? 'group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:opacity-0'
                : ''}"
              >{row.tone === "failed" || row.tone === "idle" || row.elapsedMs <= 0
                ? row.status
                : formatCompactElapsed(row.elapsedMs)}</span
            >
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={row.tooltip} />
    </TooltipUI.Root>
    {#if canStop}
      <!-- Stop shows in place of the time on hover; on touch it always shows. -->
      <button
        type="button"
        class="pointer-events-none absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) opacity-0 transition-[opacity,color,background-color] duration-150 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-status-error) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
        aria-label="Stop {row.title}"
        title="Stop agent"
        data-testid="rail-agent-stop"
        onclick={() => stop(row)}
      >
        <SquareIcon size={12} class="fill-current" aria-hidden="true" />
      </button>
    {/if}
  </li>
{/snippet}
