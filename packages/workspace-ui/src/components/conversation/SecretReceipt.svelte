<script lang="ts">
  import { Check, Minus } from "@lucide/svelte";
  import { secretReceiptRows } from "@solus/contracts/secret-request";
  import type { Message } from "@solus/contracts/types";

  /** What stays of a `request_secret` card once it closes (docs/plans/webhooks.md §3.6): one line per secret. */
  let { message }: { message: Message } = $props();
  const rows = $derived(secretReceiptRows(message.secretOutcomes ?? [], message.toolInput));
</script>

<section
  class="my-2 flex min-w-0 flex-col gap-1"
  aria-label="Secret request"
  data-testid="secret-receipt"
  data-conversation-message-id={message.id}
>
  {#each rows as row, index (index)}
    <p class="m-0 flex min-w-0 items-center gap-1.5 text-transcript-meta text-(--muted-foreground)">
      {#if row.outcome === "saved"}
        <Check size={14} class="shrink-0" aria-hidden="true" />
      {:else}
        <Minus size={14} class="shrink-0" aria-hidden="true" />
      {/if}
      <span class="min-w-0 truncate">{row.name} · {row.label}</span>
    </p>
  {/each}
</section>
