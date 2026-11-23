<script lang="ts">
  import { Bot as BotIcon } from "@lucide/svelte";
  import ProviderMark from "../ui/ProviderMark.svelte";

  /**
   * The provider mark fits the same 16px slot as other panel rows. In a
   * group header, a round tile and its opaque fill let several marks overlap.
   */
  interface Props {
    provider: string | null;
    variant?: "row" | "stack";
  }
  let { provider, variant = "stack" }: Props = $props();

  const mark = $derived(
    provider === "codex" ? "codex" : provider === "claude-code" ? "claude" : null,
  );
  // Match the provider sizes in the Environment panel's 16px icon column.
  const rowMarkSize = $derived(mark === "codex" ? 14 : 16);
</script>

<span
  aria-hidden="true"
  class="relative inline-flex shrink-0 items-center justify-center {variant === 'row'
    ? 'size-4'
    : 'size-6 rounded-full border border-[color-mix(in_oklch,var(--foreground)_10%,transparent)] bg-[color-mix(in_oklch,var(--foreground)_2%,var(--solus-tx-card-bg))] dark:border-[color-mix(in_oklch,white_5%,transparent)] dark:bg-[color-mix(in_oklch,white_3%,var(--solus-tx-card-bg))] ring-2 ring-(--solus-tx-card-bg)'}"
>
  {#if mark}
    <ProviderMark {mark} size={variant === "row" ? rowMarkSize : 13} transparent />
  {:else}
    <BotIcon size={variant === "row" ? 16 : 14} class="text-muted-foreground" />
  {/if}
</span>
