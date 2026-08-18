<script lang="ts">
  import type { AgentConversationRef } from "../../../../shared/types";
  import { agentMessages, foldMessages, foldTrail } from "./lib/agent-conversation";
  import AgentMessageBlock from "./AgentMessageBlock.svelte";

  /**
   * The message stream of one agent — the same body in the single-agent card and
   * in a switchboard tab. Height is earned: live keeps the last two messages
   * open, at rest only the final reply, and everything older folds behind one
   * row carrying the agent's own first clauses.
   */
  interface Props {
    ref: AgentConversationRef;
    agentName: string;
    live: boolean;
    /** The switchboard clamps harder — its body height is fixed. */
    clampPx?: number;
    onOpen?: () => void;
  }
  let { ref, agentName, live, clampPx = 262, onOpen }: Props = $props();

  // A pending slot is the typing indicator; once the exchange stops being live
  // it is a settle that never arrived, and the block says so instead.
  const messages = $derived(agentMessages(ref).filter((message) => live || !message.pending));
  const fold = $derived(foldMessages(messages, !live));

  // The reader can pull folded messages back; live updates never push them out
  // again mid-read.
  let foldOpenByUser = $state(false);
  const visible = $derived(foldOpenByUser ? messages : fold.open);
</script>

<!-- The stream is the card's one reading surface, so it declares the content
     rung here and every message below inherits it; the card chrome around it
     stays on the chrome ladder. -->
<div class="text-caption">
  {#if fold.folded.length > 0}
    <button
      class="flex items-center gap-2 w-full py-2.5 text-left text-xs text-muted-foreground cursor-pointer hover:text-foreground"
      onclick={() => (foldOpenByUser = !foldOpenByUser)}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="shrink-0 transition-transform {foldOpenByUser ? 'rotate-90' : ''}"
      >
        <path d="M4.2 2.4L7.8 6l-3.6 3.6" />
      </svg>
      <span class="shrink-0">
        {fold.folded.length}
        {fold.folded.length === 1 ? "earlier message" : "earlier messages"}
      </span>
      <span class="truncate opacity-60">{foldTrail(fold.folded)}</span>
    </button>
  {/if}

  {#each visible as message, index (message.key)}
    <AgentMessageBlock
      {message}
      {agentName}
      {live}
      {clampPx}
      {onOpen}
      first={index === 0 && fold.folded.length === 0}
    />
  {/each}
</div>
