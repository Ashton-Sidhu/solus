<script lang="ts">
  /**
   * Live only, and where every action lives. At rest the footer is removed
   * entirely — a settled exchange has nothing left to do but be read.
   *
   * Messages to the other agent come from this conversation's agent, never from
   * the card; when the other agent needs a person, its request renders above
   * with the same card it would have in its own session.
   *
   * Open session and Split are two explicit controls rather than a menu: Split
   * puts the other side beside this conversation and leaves focus here, so a
   * live exchange stays watchable while you read it.
   */
  interface Props {
    agentName: string;
    /** The agent's turn is waiting on a person, and its request is above. */
    needsYou?: boolean;
    /** The agent's turn is parked on its provider's rate limit. */
    limited?: boolean;
    /** When the limit resets, if the provider said. */
    resumesAt?: string;
    onOpen: (opts: { split?: boolean; background?: boolean }) => void;
    /** Absent once the agent has stopped writing. */
    onStop?: () => void;
  }
  let { agentName, needsYou = false, limited = false, resumesAt, onOpen, onStop }: Props = $props();
</script>

<div
  class="flex items-center gap-2.5 px-3.5 py-2 text-transcript-meta border-t-[0.5px] border-(--solus-agent-card-rule) {needsYou
    ? 'bg-[color-mix(in_oklch,var(--chart-2)_7%,transparent)]'
    : 'bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)]'}"
>
  <span class="min-w-0 truncate text-muted-foreground">
    {needsYou
      ? `${agentName} is waiting on you`
      : limited
        ? `${agentName} is rate limited${resumesAt ? ` until ${resumesAt}` : ""} · resumes on its own`
        : `${agentName} is working`}
  </span>
  <span class="flex-1"></span>

  {#if onStop}
    <button
      class="flex items-center gap-1.5 shrink-0 rounded-md px-2 py-0.5 text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--destructive)_12%,transparent)] hover:text-(--destructive)"
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
    class="flex items-center gap-1.5 shrink-0 rounded-md px-2 py-0.5 text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground"
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
