<script lang="ts">
  import { getTranscriptDisclosure } from "./lib/transcript-disclosure.svelte";
  import type { Message } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { formatActivityDuration } from "./lib/activity-summary";
  import { agentExecutionElapsedMs, agentExecutionLink, agentGroupElapsedMs, agentMarkShowsElapsed, summarizeAgentLinks } from "./lib/agent-link";
  import { subagentRow } from "./lib/subagent-group";
  import { runHost } from "../../contexts/workspace/run-location";
  import { sessionTreeStore } from "../../contexts/sessions/session-tree.store.svelte";
  import AgentStateMark from "./AgentStateMark.svelte";
  import AgentAvatar from "./AgentAvatar.svelte";
  import SubagentLink from "./SubagentLink.svelte";
  import TranscriptCard from "./TranscriptCard.svelte";
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

  const serverId = $derived(runHost(sess?.run));
  const onScreen = conversationIsVisible();
  $effect(() => {
    if (sess?.id && serverId && onScreen()) return sessionTreeStore.retain(serverId, sess.id);
  });

  const executions = $derived(messages.map((message) =>
    sess ? session.sessions.executionFor(serverId, sess.id, message.toolId ?? message.id) : undefined,
  ));
  const links = $derived(executions.map((execution) => agentExecutionLink(execution, { providerSubagent: true })));
  const summary = $derived(summarizeAgentLinks(links));
  const title = $derived(`${messages.length} agents`);
  let now = $state(Date.now());
  const elapsedMs = $derived(agentGroupElapsedMs(executions, now));
  $effect(() => {
    if (!links.some((link) => link.standing === "live" && agentMarkShowsElapsed(link.mark)) || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });

  const rows = $derived(messages.map((message, index) => {
    const row = subagentRow(message, now, {
      model: (sess?.sessionModel || sess?.run.modelConfig.modelId || "").trim(),
      effort: (sess?.run.modelConfig.reasoningEffort || "").trim(),
    });
    const elapsedMs = agentExecutionElapsedMs(executions[index], now);
    return { row, link: links[index], elapsed: elapsedMs !== null && elapsedMs > 0 ? formatActivityDuration(elapsedMs) : "" };
  }));

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
      <SubagentLink {...rows[0]} {tabId} />
    </div>
  </div>
{:else}
  <!-- The shared card shell, so the header, caret, and rail match every other
       transcript card. Opening it lists one row per agent. -->
  <TranscriptCard
    {title}
    {expanded}
    bodyLayout="rows"
    failed={summary.failed && !summary.live}
    ariaLabel={`${title}, ${summary.status}`}
    data-testid="subagent-group"
    {skipMotion}
    onOpen={() => (view.openedByUser = !expanded)}
  >
    {#snippet glyph()}
      <span class="flex items-center -space-x-1.5">
        {#each rows.slice(0, STACKED_AVATARS) as { row } (row.id)}
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
    {/snippet}
    {#snippet rail()}
      {#if elapsedMs !== null && elapsedMs > 0 && summary.mark && agentMarkShowsElapsed(summary.mark)}
        <span class="font-mono">{formatActivityDuration(elapsedMs)}</span>
      {/if}
      {#if summary.mark}<AgentStateMark mark={summary.mark} label={summary.status} />{/if}
    {/snippet}
    {#snippet body()}
      {#each rows as entry (entry.row.id)}
        <SubagentLink {...entry} {tabId} />
      {/each}
    {/snippet}
  </TranscriptCard>
{/if}
