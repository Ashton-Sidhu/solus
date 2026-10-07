<script lang="ts">
  import { Check as CheckIcon, LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import { Button } from "../ui/button";
  import ProviderLogo from "./ProviderLogo.svelte";
  import type { ProviderRow } from "./lib/host-onboarding";

  interface Props {
    /** Built by `gitHostRows` / `codingProviderRows` — this only draws them. */
    rows: ProviderRow[];
    label: string;
    /** Rows sit between hairlines on the surface instead of inside a card. */
    flush?: boolean;
  }

  let { rows, label, flush = false }: Props = $props();
</script>

{#if flush}
  <div class="flex flex-col" role="list" aria-label={label}>
    {#each rows as row (row.id)}
      <div
        class="flex min-h-13 items-center gap-3 border-foreground/8 not-first:border-t"
        role="listitem"
      >
        <ProviderLogo provider={row.id} />
        <span class="flex min-w-0 flex-1 items-baseline gap-2">
          <span class="shrink-0 font-medium text-foreground">{row.label}</span>
          <span class="min-w-0 truncate text-[0.8125rem] text-muted-foreground">{row.detail}</span>
        </span>
        {#if row.state !== "busy" && row.secondary}
          <Button
            variant="ghost"
            size="sm"
            class="shrink-0 text-muted-foreground"
            aria-label="{row.secondary.label} to {row.label}"
            disabled={row.disabled}
            onclick={row.secondary.run}
          >
            {row.secondary.label}
          </Button>
        {/if}
        {#if row.state === "busy"}
          <CircleNotchIcon size={14} class="shrink-0 animate-spin text-primary" />
        {:else if row.state === "done"}
          <CheckIcon size={14} strokeWidth={2.6} class="shrink-0 text-(--success)" aria-label="Done" />
        {:else}
          <Button
            variant="outline"
            size="sm"
            class="shrink-0"
            disabled={row.disabled}
            onclick={row.run}
          >
            {row.actionLabel}
          </Button>
        {/if}
      </div>
    {/each}
  </div>
{:else}
<div
  class="mt-3.5 overflow-hidden rounded-2xl border border-(--solus-container-border) bg-card shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.04)]"
  role="list"
  aria-label={label}
>
  {#each rows as row, index (row.id)}
    <div
      class="flex items-center gap-[0.6875rem] px-[0.8125rem] py-[0.6875rem] {index > 0
        ? 'border-t border-(--solus-container-border)'
        : ''}"
      role="listitem"
    >
      <ProviderLogo provider={row.id} />
      <span class="flex min-w-0 flex-1 flex-col">
        <span
          class="truncate text-sm font-medium leading-[1.3] text-(--solus-text-primary)"
        >
          {row.label}
        </span>
        <span
          class="whitespace-normal break-words text-xs leading-[1.35] text-(--solus-text-tertiary)"
          style="font-family: 'Geist Mono', ui-monospace, monospace"
        >
          {row.detail}
        </span>
      </span>

        {#if row.state !== "busy" && row.secondary}
          <Button
            variant="ghost"
            size="sm"
            class="h-[1.625rem] shrink-0 px-[0.5rem] text-xs text-[color:var(--solus-text-tertiary)]"
            aria-label="{row.secondary.label} to {row.label}"
            disabled={row.disabled}
            onclick={row.secondary.run}
          >
            {row.secondary.label}
          </Button>
        {/if}
      {#if row.state === "busy"}
        <CircleNotchIcon size={12} class="mr-0.5 shrink-0 animate-spin text-(--solus-accent)" />
      {:else if row.state === "done"}
        <span
          class="mr-0.5 flex size-[1.0625rem] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--solus-accent)_13%,transparent)]"
        >
          <CheckIcon size={9} weight="bold" class="text-(--solus-accent)" />
        </span>
      {:else}
        <Button
          variant="outline"
          size="sm"
          class="h-[1.625rem] shrink-0 px-[0.6875rem] text-xs"
          disabled={row.disabled}
          onclick={row.run}
        >
          {row.actionLabel}
        </Button>
      {/if}
    </div>
  {/each}
</div>
{/if}
