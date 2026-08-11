<script lang="ts">
  import AgentConversationComposer from "./AgentConversationComposer.svelte";

  /**
   * Live only, and where every action lives. At rest the footer is removed
   * entirely — a settled exchange has nothing left to do but be read.
   *
   * Open session and Split are two explicit controls rather than a menu: Split
   * puts the other side beside this conversation and leaves focus here, so a
   * live exchange stays watchable while you read it.
   */
  interface Props {
    agentName: string;
    /** The agent asked you something — the footer becomes the answer field. */
    needsYou?: boolean;
    /** A permission or a plan can't be answered by typing at it. */
    answerInSessionOnly?: boolean;
    onSend: (
      text: string,
      scope: "one" | "all",
    ) => Promise<"sent" | "queued" | "failed">;
    onOpen: (opts: { split?: boolean; background?: boolean }) => void;
    /** Absent once the agent has stopped writing. */
    onStop?: () => void;
    broadcastLabel?: string;
  }
  let {
    agentName,
    needsYou = false,
    answerInSessionOnly = false,
    onSend,
    onOpen,
    onStop,
    broadcastLabel,
  }: Props = $props();
</script>

<div
  class="flex items-center gap-2.5 px-[15px] py-2.5 border-t-[0.5px] border-(--solus-agent-card-rule) {needsYou
    ? 'bg-[color-mix(in_oklch,var(--chart-2)_7%,transparent)]'
    : 'bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)]'}"
>
  {#if needsYou && answerInSessionOnly}
    <span class="text-[12.5px] text-muted-foreground">
      {agentName} needs an answer in its own session
    </span>
    <span class="flex-1"></span>
  {:else}
    <AgentConversationComposer
      placeholder={needsYou
        ? `Answer ${agentName}…`
        : `Say something to ${agentName}…`}
      emphasis={needsYou}
      {broadcastLabel}
      {onSend}
    />
  {/if}

  {#if onStop}
    <button
      class="flex items-center gap-1.5 shrink-0 rounded-lg px-2.5 py-1 text-[12px] text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)] hover:text-(--destructive)"
      onclick={onStop}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      >
        <rect x="2.8" y="2.8" width="6.4" height="6.4" rx="1.4" />
      </svg>
      Stop
    </button>
  {/if}

  <button
    class="flex items-center gap-1.5 shrink-0 rounded-lg px-2.5 py-1 text-[12px] text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
    title="Open in a new tab"
    onclick={(e) =>
      onOpen({ split: e.metaKey || e.ctrlKey, background: e.shiftKey })}
  >
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M4.6 2.4h5v5M9.6 2.4L5 7M9 7.6v1.4a.9.9 0 01-.9.9H3a.9.9 0 01-.9-.9V3.9A.9.9 0 013 3h1.4"
      />
    </svg>
    Open session
  </button>

  <button
    class="flex items-center justify-center shrink-0 size-[26px] rounded-lg text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
    title="Open in split view"
    aria-label="Open {agentName} beside this conversation"
    onclick={() => onOpen({ split: true })}
  >
    <svg
      width="13"
      height="13"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linejoin="round"
    >
      <rect x="1.8" y="2.4" width="10.4" height="9.2" rx="1.4" />
      <path d="M7 2.4v9.2" />
    </svg>
  </button>
</div>
