<script lang="ts">
  import type { Message } from "@solus/contracts/types";
  import { agentConversationLayout } from "./lib/agent-conversation";
  import AgentConversationCard from "./AgentConversationCard.svelte";
  import AgentConversationSwitchboard from "./AgentConversationSwitchboard.svelte";

  /**
   * The turn's exchanges with other agents. One agent is a two-voice card; two
   * or more share one card with a tab row. Either way it sits in the agent's
   * message flow at full column width, never inside a user bubble.
   */
  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  const cards = $derived(messages.filter((message) => message.agentConversationRef));
  const refs = $derived(cards.map((message) => message.agentConversationRef!));
</script>

<div class="py-2">
  {#if agentConversationLayout(refs) === "single"}
    {#each cards as message (message.id)}
      <AgentConversationCard ref={message.agentConversationRef!} {tabId} {skipMotion} />
    {/each}
  {:else}
    <AgentConversationSwitchboard {refs} {tabId} {skipMotion} />
  {/if}
</div>
