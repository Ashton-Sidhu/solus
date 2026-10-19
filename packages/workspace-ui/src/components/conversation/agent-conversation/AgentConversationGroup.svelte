<script lang="ts">
  import type { Message } from "@solus/contracts/types";
  import AgentAvatar from "../AgentAvatar.svelte";
  import TranscriptCard from "../TranscriptCard.svelte";
  import { conversationIsVisible } from "../lib/conversation-visibility";
  import { getTranscriptDisclosure } from "../lib/transcript-disclosure.svelte";
  import { liveActivityClock } from "../../../lib/shared-clock";
  import AgentConversationCard from "./AgentConversationCard.svelte";
  import { agentConversationMeta } from "./agent-conversation-meta.store.svelte";
  import {
    agentConversationGroupElapsedMs,
    agentConversationGroupSummary,
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
  const summary = $derived(agentConversationGroupSummary(refs));

  let now = $state(Date.now());
  const onScreen = conversationIsVisible();
  $effect(() => {
    if (!isBatch || !summary.live || !onScreen()) return;
    return liveActivityClock.subscribe((value) => { now = value; });
  });
  const elapsed = $derived(formatAgentConversationDuration(agentConversationGroupElapsedMs(refs, now)));

  // Folded until the reader opens it. A session that waits on a person opens
  // it, because the answer is given in that session's row.
  const disclosure = getTranscriptDisclosure();
  const view = $derived(disclosure.forKey(`agents:${cards[0]?.id}`));
  const expanded = $derived(view.openedByUser ?? summary.needsPerson);
</script>

{#if !isBatch}
  <div class="flex flex-col py-1">
    {#each cards as message (message.id)}
      <AgentConversationCard ref={message.agentConversationRef!} {tabId} {skipMotion} />
    {/each}
  </div>
{:else}
  <TranscriptCard
    title={summary.title}
    target={summary.status}
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
        {#each refs.slice(0, STACKED_AVATARS) as ref (ref.sessionId)}
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
      <span class="font-mono">{elapsed}</span>
    {/snippet}
    {#snippet body()}
      {#each cards as message, index (message.id)}
        <AgentConversationCard ref={message.agentConversationRef!} {tabId} skipMotion accentIndex={index} grouped />
      {/each}
    {/snippet}
  </TranscriptCard>
{/if}
