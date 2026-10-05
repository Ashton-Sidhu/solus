<script lang="ts">
  import { Bot as BotIcon } from "@lucide/svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";
  import type { AgentLinkTone } from "./lib/agent-link";

  /**
   * A round provider tile with a status dot, as T3 Code draws it: one quiet
   * tile for every provider, and the mark carries the identity — Claude in its
   * brand colour, Codex in the text colour. The ring lets avatars
   * overlap in a group header, where the dot is left out because a covered dot
   * is noise. The fill is opaque — a mix with the card, not a wash — so a
   * covered avatar's edge never shows through the one above it.
   */
  interface Props {
    provider: string;
    tone?: AgentLinkTone;
  }
  let { provider, tone }: Props = $props();

  const mark = $derived(
    provider === "codex" ? "codex" : provider === "claude-code" ? "claude" : null,
  );
</script>

<span
  aria-hidden="true"
  class="relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_oklch,var(--foreground)_10%,transparent)] bg-[color-mix(in_oklch,var(--foreground)_2%,var(--solus-tx-card-bg))] dark:border-[color-mix(in_oklch,white_5%,transparent)] dark:bg-[color-mix(in_oklch,white_3%,var(--solus-tx-card-bg))] ring-2 ring-(--solus-tx-card-bg)"
>
  {#if mark}
    <ProviderMark {mark} size={13} transparent />
  {:else}
    <BotIcon size={14} class="text-muted-foreground" />
  {/if}
  {#if tone}
    <span
      class="absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-(--solus-tx-card-bg) {tone ===
      'live'
        ? 'bg-(--chart-5)'
        : tone === 'done'
          ? 'bg-(--chart-3)'
          : tone === 'failed'
            ? 'bg-destructive'
            : 'bg-[color-mix(in_oklch,var(--muted-foreground)_50%,transparent)]'}"
    ></span>
  {/if}
</span>
