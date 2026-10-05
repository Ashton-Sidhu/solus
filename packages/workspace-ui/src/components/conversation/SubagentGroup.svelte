<script lang="ts">
  import { ChevronDown as ChevronDownIcon } from "@lucide/svelte";
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import type { Message } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import { subagentStatusLine } from "./lib/agent-link";
  import { subagentGroupSummary, subagentRow } from "./lib/subagent-group";
  import AgentAvatar from "./AgentAvatar.svelte";
  import SubagentLink from "./SubagentLink.svelte";
  import { liveActivityClock } from "../../lib/shared-clock";
  import { conversationIsVisible } from "./lib/conversation-visibility";

  /**
   * §18 — the sub-agents one turn launches, as T3 Code shows them. A lone agent
   * is one flat row. Several fold behind one header: their avatars stacked, the
   * count, a status line, and the time. Opening it lists one row per agent.
   */
  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  /** Avatars the header stacks before it counts the rest. */
  const STACKED_AVATARS = 3;

  const session = getWorkspaceContext();
  const sess = $derived(session.sessionFor(tabId));

  const isBatch = $derived(messages.length > 1);

  // Read off the messages, not off `summary` — a clock the summary depends on
  // would tear down and rebuild its own interval on every tick.
  const runningCount = $derived(
    messages.filter((message) => message.toolStatus === "running").length,
  );

  let now = $state(Date.now());
  const rows = $derived(
    messages.map((message) =>
      subagentRow(message, now, {
        model: (
          sess?.sessionModel ||
          sess?.run.modelConfig.modelId ||
          ""
        ).trim(),
        effort: (sess?.run.modelConfig.reasoningEffort || "").trim(),
      }),
    ),
  );
  const summary = $derived(subagentGroupSummary(messages, rows, now));
  const onScreen = conversationIsVisible();
  $effect(() => {
    if (runningCount === 0 || !onScreen()) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  const statusLine = $derived(subagentStatusLine(rows.map((row) => row.state)));

  // Folded until the reader opens it, the same as T3 Code.
  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`subagents:${messages[0]?.id}`));
  const expanded = $derived(view.openedByUser === true);
</script>

{#if !isBatch}
  <div class="py-1 {skipMotion ? '' : 'animate-msg-in-side'}">
    <!-- The transcript card's surface: its fill, radius, and quiet ring. -->
    <div
      class="rounded-(--tx-card-radius) bg-(--solus-tx-card-bg) p-1 shadow-[shadow:var(--solus-tx-quiet-shadow)]"
    >
      <SubagentLink row={rows[0]} {tabId} />
    </div>
  </div>
{:else}
  <!-- `activity-host` opts the group out of the transcript's paint containment. -->
  <div class="activity-host py-1 {skipMotion ? '' : 'animate-msg-in-side'}" data-testid="subagent-group">
    <div
      class="overflow-hidden rounded-(--tx-card-radius) bg-(--solus-tx-card-bg) shadow-[shadow:var(--solus-tx-quiet-shadow)]"
    >
      <button
        type="button"
        class="flex w-full min-w-0 cursor-pointer items-center gap-3 overflow-hidden border-none bg-transparent px-3 py-2 text-left transition-opacity hover:opacity-100 {expanded ||
        runningCount > 0
          ? 'text-(--solus-text-primary) opacity-100'
          : 'text-muted-foreground opacity-55'}"
        aria-expanded={expanded}
        aria-label={`${summary.title}, ${statusLine}`}
        onclick={() => (view.openedByUser = !expanded)}
      >
        <span class="flex shrink-0 items-center -space-x-1.5" aria-hidden="true">
          {#each rows.slice(0, STACKED_AVATARS) as row (row.id)}
            <AgentAvatar provider={row.provider} />
          {/each}
          {#if rows.length > STACKED_AVATARS}
            <span
              class="relative inline-flex size-6 items-center justify-center rounded-full border border-[color-mix(in_oklch,var(--foreground)_10%,transparent)] bg-[color-mix(in_oklch,var(--foreground)_2%,var(--solus-tx-card-bg))] dark:border-[color-mix(in_oklch,white_5%,transparent)] dark:bg-[color-mix(in_oklch,white_3%,var(--solus-tx-card-bg))] text-[0.625rem] font-medium tabular-nums text-muted-foreground ring-2 ring-(--solus-tx-card-bg)"
            >
              +{rows.length - STACKED_AVATARS}
            </span>
          {/if}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block text-xs font-semibold">{summary.title}</span>
          <span
            class="block truncate text-[0.625rem] {runningCount > 0
              ? 'text-(--chart-5)'
              : summary.failed > 0
                ? 'text-destructive'
                : 'text-muted-foreground'}">{statusLine}</span
          >
        </span>
        <span class="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground"
          >{formatActivityDuration(summary.elapsedMs)}</span
        >
        <ChevronDownIcon
          size={14}
          aria-hidden="true"
          class="shrink-0 text-muted-foreground transition-transform {expanded ? 'rotate-180' : ''}"
        />
      </button>
      {#if expanded}
        <!-- One row per agent under a hairline, inside the same card. -->
        <div class="border-t-[0.5px] border-(--solus-tx-divider) p-1">
          {#each rows as row (row.id)}
            <SubagentLink {row} {tabId} />
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}
