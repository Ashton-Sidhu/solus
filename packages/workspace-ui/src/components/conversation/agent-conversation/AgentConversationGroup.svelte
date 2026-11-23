<script lang="ts">
  import type { Message } from "@solus/contracts/types";
  import AgentStateMark from "../AgentStateMark.svelte";
  import { agentGroupElapsedMs, agentMarkShowsElapsed } from "../lib/agent-link";
  import AgentAvatar from "../AgentAvatar.svelte";
  import TranscriptCard from "../TranscriptCard.svelte";
  import { conversationIsVisible } from "../lib/conversation-visibility";
  import { getTranscriptDisclosure } from "../lib/transcript-disclosure.svelte";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import AgentConversationCard from "./AgentConversationCard.svelte";
  import ArtifactChip from "./ArtifactChip.svelte";
  import { chipTotals } from "@solus/client-core/session-artifact-chips";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { getWorkspaceContext } from "../../../contexts";
  import { sessionTreeStore } from "../../../contexts/sessions/session-tree.store.svelte";
  import { runHost } from "../../../contexts/workspace/run-location";
  import { ensureLinkedArtifacts, linkedArtifacts } from "./lib/linked-artifacts.svelte";
  import { agentConversationMeta } from "./agent-conversation-meta.store.svelte";
  import {
    agentConversationGroupSummary,
    agentConversationLink,
    isPendingAgent,
    formatAgentConversationDuration,
  } from "./lib/agent-conversation";

  /**
   * The turn's exchanges with other agents: one two-voice card per agent, in
   * dispatch order. One agent is its card. Several fold behind one header, as
   * sub-agents do: their avatars stacked, the count, a status line, and the
   * time. Opening it lists one row per agent. It sits in the agent's message
   * flow at full column width, never inside a user bubble.
   */
  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  /** Avatars the header stacks before it counts the rest. */
  const STACKED_AVATARS = 3;

  const cards = $derived(messages.filter((message) => message.agentConversationRef));
  const refs = $derived(cards.map((message) => message.agentConversationRef!));
  const isBatch = $derived(cards.length > 1);
  const session = getWorkspaceContext();
  const caller = $derived({
    sessionId: session.sessionFor(tabId)?.id,
    serverId: runHost(session.sessionFor(tabId)?.run),
  });
  const summary = $derived(agentConversationGroupSummary(refs, (ref) => {
    const serverId = ref.serverId ?? caller.serverId;
    const execution = session.sessions.executionFor(serverId, ref.sessionId);
    const activity = serverId && execution?.current?.phase === "running" ? session.sessions.activityFor(serverId, ref.sessionId) : null;
    return agentConversationLink(ref, execution, activity);
  }));

  let now = $state(Date.now());
  const onScreen = conversationIsVisible();
  $effect(() => {
    if (caller.serverId && caller.sessionId && onScreen()) return sessionTreeStore.retain(caller.serverId, caller.sessionId);
  });
  $effect(() => {
    if (!isBatch || !summary.live || !agentMarkShowsElapsed(summary.mark) || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });
  const elapsedMs = $derived(agentGroupElapsedMs(refs.map((ref) =>
    session.sessions.executionFor(ref.serverId ?? caller.serverId, ref.sessionId),
  ), now));
  const elapsed = $derived(elapsedMs !== null && elapsedMs > 0 ? formatAgentConversationDuration(elapsedMs) : "");

  // Folded until the reader opens it. A session that waits on a person opens
  // it, because the answer is given in that session's row.
  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`agents:${cards[0]?.id}`));
  const expanded = $derived(view.openedByUser ?? summary.needsPerson);

  // Folded, the header totals what the sessions linked; open, each row shows its own.
  $effect(() => {
    if (!isBatch) return;
    for (const ref of refs) ensureLinkedArtifacts(ref, caller);
  });
  const trackedAgents = $derived(refs.filter((ref) => !isPendingAgent(ref)).map((ref) => ({
    sessionId: ref.sessionId, serverId: ref.serverId ?? caller.serverId,
  })));
  $effect(() => {
    if (!isBatch) return;
    const releases = trackedAgents.flatMap(({ sessionId, serverId }) =>
      serverId ? [agentConversationMeta.retain(sessionId, serverConnections.apiFor(serverId), serverId)] : [],
    );
    return () => releases.forEach((release) => release());
  });
  const totals = $derived(isBatch ? chipTotals(refs.map((ref) => linkedArtifacts(ref, caller))) : []);

  function openCallerArtifacts() {
    if (caller.sessionId) session.openArtifacts(caller.sessionId);
  }
</script>

{#if !isBatch}
  <div class="flex flex-col py-1">
    {#each cards as message (message.id)}
      <AgentConversationCard ref={message.agentConversationRef!} {tabId} {skipMotion} />
    {/each}
  </div>
{:else}
  <div class="@container/agents">
    <TranscriptCard
      title={summary.title}
      {expanded}
      bodyLayout="rows"
      failed={summary.failed && !summary.live}
      waiting={summary.needsPerson}
      ariaLabel={`${summary.title}, ${summary.status}`}
      data-testid="agent-conversation-group"
      {skipMotion}
      onOpen={() => (view.openedByUser = !expanded)}
    >
      {#snippet glyph()}
        <span class="flex items-center -space-x-1.5">
          {#each cards.slice(0, STACKED_AVATARS) as message (message.id)}
            {@const ref = message.agentConversationRef!}
            <AgentAvatar provider={agentConversationMeta.metaFor(ref.sessionId)?.provider ?? ref.provider} />
          {/each}
          {#if refs.length > STACKED_AVATARS}
            <span
              class="relative inline-flex size-6 items-center justify-center rounded-full border border-[color-mix(in_oklch,var(--foreground)_10%,transparent)] bg-[color-mix(in_oklch,var(--foreground)_2%,var(--solus-tx-card-bg))] dark:border-[color-mix(in_oklch,white_5%,transparent)] dark:bg-[color-mix(in_oklch,white_3%,var(--solus-tx-card-bg))] text-[0.625rem] font-medium tabular-nums text-muted-foreground ring-2 ring-(--solus-tx-card-bg)"
            >
              +{refs.length - STACKED_AVATARS}
            </span>
          {/if}
        </span>
      {/snippet}
      {#snippet rail()}
        {#if !expanded && totals.length > 0}
          <!-- Dropped before the title is: below 40rem the totals hide, and the
               rows still show every item once the group opens. -->
          <span class="hidden items-center gap-1 @min-[40rem]/agents:inline-flex" data-testid="agent-group-artifacts">
            {#each totals as total (total.kind)}
              <ArtifactChip
                tone={total.tone}
                label={total.label}
                pullRequestState={total.pullRequestState}
                onclick={openCallerArtifacts}
              />
            {/each}
          </span>
        {/if}
        {#if elapsed && summary.mark && agentMarkShowsElapsed(summary.mark)}<span class="font-mono">{elapsed}</span>{/if}
        {#if summary.mark}<AgentStateMark mark={summary.mark} label={summary.status} />{/if}
      {/snippet}
      {#snippet body()}
        {#each cards as message, index (message.id)}
          <AgentConversationCard ref={message.agentConversationRef!} {tabId} skipMotion accentIndex={index} grouped />
        {/each}
      {/snippet}
    </TranscriptCard>
  </div>
{/if}
