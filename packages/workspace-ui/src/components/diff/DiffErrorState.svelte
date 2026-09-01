<script lang="ts">
  import { RotateCw as ArrowClockwiseIcon, TriangleAlert as WarningIcon } from "@lucide/svelte";

  interface Props {
    title: string;
    message: string;
    retryLabel?: string;
    onRetry: () => void;
    /** See DiffEmptyState: the panel measures the pane and says whether it is
     *  too narrow for a centred card. */
    stacked?: boolean;
  }

  let { title, message, retryLabel = "Retry", onRetry, stacked = false }: Props = $props();

  // Same rule as the empty state: in a narrow pane the card sits at the top and
  // states what happened in a full line, rather than floating in the middle of a
  // column with nothing else in it.
  const isPhone = $derived(stacked);
</script>

{#if isPhone}
  <div class="flex-1 px-4 pt-4">
    <div class="flex flex-col gap-2.5 rounded-2xl bg-(--card) p-[1.125rem] text-sm shadow-[shadow:var(--elev-ring)]">
      <div class="flex items-center gap-2.5">
        <span
          class="flex size-[1.875rem] shrink-0 items-center justify-center rounded-lg"
          style="background:color-mix(in oklch, var(--failure) 20%, transparent);color:color-mix(in oklch, var(--failure) 60%, var(--foreground))"
        >
          <WarningIcon size={15} />
        </span>
        <div class="min-w-0 flex-1 font-semibold tracking-[-0.01em] text-(--solus-text-primary)">
          {title}
        </div>
      </div>
      <p class="leading-[1.65] text-(--muted-foreground) text-pretty">{message}</p>
      <button
        type="button"
        class="mt-0.5 flex h-[2.125rem] w-fit cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent px-3.5 font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] [-webkit-tap-highlight-color:transparent]"
        onclick={onRetry}
      >
        <ArrowClockwiseIcon size={14} />
        {retryLabel}
      </button>
    </div>
  </div>
{:else}
  <div class="flex-1 flex items-center justify-center px-6">
    <div
      class="flex flex-col items-center text-center gap-3 py-8 px-5 rounded-2xl border border-(--solus-container-border) max-w-xs"
      style="background:var(--solus-surface-hover)"
    >
      <span
        class="flex items-center justify-center rounded-full"
        style="width:2.25rem;height:2.25rem;background:var(--solus-status-error-bg);color:var(--solus-status-error)"
      >
        <WarningIcon size={20} weight="duotone" />
      </span>
      <div class="flex flex-col gap-1">
        <span class="text-xs font-medium text-(--solus-text-primary)">
          {title}
        </span>
        <span
          class="text-xs text-(--solus-text-tertiary) leading-snug"
        >
          {message}
        </span>
      </div>
      <button
        onclick={onRetry}
        class="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md cursor-pointer transition-colors text-(--solus-text-primary) hover:bg-(--solus-surface-hover) border border-(--solus-container-border)"
      >
        <ArrowClockwiseIcon size={14} weight="bold" />
        {retryLabel}
      </button>
    </div>
  </div>
{/if}
