<script lang="ts">
  import type { Message } from "@solus/contracts/types";
  import AgentConversationCard from "./AgentConversationCard.svelte";

  /**
   * The turn's exchanges with other agents: one two-voice card per agent,
   * stacked in dispatch order. It sits in the agent's message flow at full
   * column width, never inside a user bubble.
   */
  interface Props {
    messages: Message[];
    tabId: string;
    skipMotion?: boolean;
  }
  let { messages, tabId, skipMotion = false }: Props = $props();

  const cards = $derived(messages.filter((message) => message.agentConversationRef));
</script>

<div class="flex flex-col gap-2 py-2">
  {#each cards as message, index (message.id)}
    <AgentConversationCard ref={message.agentConversationRef!} {tabId} {skipMotion} accentIndex={index} />
  {/each}
</div>
