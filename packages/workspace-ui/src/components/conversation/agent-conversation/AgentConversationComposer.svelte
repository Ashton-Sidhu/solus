<script lang="ts">
  import { ArrowUp as ArrowUpIcon } from "@lucide/svelte";

  /**
   * The footer field. Sending here goes straight to that agent's session — it
   * does not add a turn to your own conversation; your agent sees it as context
   * on its next turn.
   *
   * Who receives the text is the card's business, not the field's: the card
   * passes `onSend`, and a switchboard passes a broadcast label so the same
   * draft can go to every unfinished agent at once.
   */
  interface Props {
    placeholder: string;
    onSend: (text: string, scope: "one" | "all") => Promise<"sent" | "queued" | "failed">;
    /** A blocked agent's answer field: card fill and an explicit Send, because
     *  it is the one thing the card is asking the reader to do. */
    emphasis?: boolean;
    /** e.g. "Say it to all 3" — omitted on a single-agent card. */
    broadcastLabel?: string;
  }
  let { placeholder, onSend, emphasis = false, broadcastLabel }: Props = $props();

  let draft = $state("");
  let sending = $state(false);
  let notice = $state<string | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);

  async function send(scope: "one" | "all") {
    const text = draft.trim();
    if (!text || sending) return;
    sending = true;
    try {
      const result = await onSend(text, scope);
      if (result !== "failed") draft = "";
      notice = result === "failed" ? "failed to send" : result;
      setTimeout(() => (notice = null), 2500);
    } finally {
      sending = false;
      inputEl?.focus();
    }
  }
</script>

<input
  bind:this={inputEl}
  bind:value={draft}
  aria-label={placeholder}
  {placeholder}
  class="flex-1 min-w-0 text-transcript-card outline-none placeholder:text-muted-foreground {emphasis
    ? 'bg-(--solus-tx-card-bg) rounded-md px-2.5 py-1.5 shadow-[inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)]'
    : 'bg-transparent'}"
  onkeydown={(e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send("one");
    }
  }}
/>

{#if notice}
  <span class="shrink-0 text-transcript-meta text-muted-foreground/60">{notice}</span>
{/if}

{#if broadcastLabel}
  <button
    class="shrink-0 rounded-md px-2 py-1 text-transcript-meta text-muted-foreground cursor-pointer hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground disabled:opacity-40"
    disabled={!draft.trim() || sending}
    onclick={() => send("all")}
  >
    {broadcastLabel}
  </button>
{/if}

{#if emphasis}
  <button
    class="flex items-center justify-center shrink-0 size-6 rounded-md bg-primary text-primary-foreground cursor-pointer hover:brightness-105 disabled:opacity-40"
    disabled={!draft.trim() || sending}
    onclick={() => send("one")}
    aria-label="Send"
  >
    <ArrowUpIcon size={12} />
  </button>
{/if}
