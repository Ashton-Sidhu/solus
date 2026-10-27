<script lang="ts">
  import { Check as CheckIcon, LoaderCircle as CircleNotchIcon } from "@lucide/svelte";
  import ProviderConnectedCheck from "../settings/ProviderConnectedCheck.svelte";
  import { Button } from "../ui/button";
  import { RowCard } from "../ui/row-card";
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

{#snippet actions(row: ProviderRow)}
  {#if row.state !== "busy" && row.update}
    <Button
      variant="outline"
      size="sm"
      class="shrink-0"
      aria-label="{row.update.label} for {row.label}"
      disabled={row.disabled}
      onclick={row.update.run}
    >
      {row.update.label}
    </Button>
  {/if}
  {#if row.state !== "busy" && row.secondary}
    <Button
      variant="ghost"
      size="sm"
      class="shrink-0 text-muted-foreground"
      aria-label="{row.secondary.label} for {row.label}"
      disabled={row.disabled}
      onclick={row.secondary.run}
    >
      {row.secondary.label}
    </Button>
  {/if}
  {#if row.state === "available"}
    <Button size="sm" class="shrink-0" disabled={row.disabled} onclick={row.run}>
      {row.actionLabel}
    </Button>
  {/if}
{/snippet}

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
        {@render actions(row)}
        {#if row.state === "busy"}
          <CircleNotchIcon size={14} class="shrink-0 animate-spin text-primary" />
        {:else if row.state === "done"}
          <CheckIcon size={14} strokeWidth={1.5} class="shrink-0 text-(--success)" aria-label="Done" />
        {/if}
      </div>
    {/each}
  </div>
{:else}
  <!-- The Settings row: brand mark, name with its signed-in check, one quiet
       line of status, and the row's actions at the trailing edge. The actions
       wrap under the copy when the pane is too narrow for both. -->
  <div role="list" aria-label={label}>
    <RowCard>
      {#each rows as row (row.id)}
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5" role="listitem">
          <div class="flex min-w-48 flex-1 items-center gap-3">
            <ProviderLogo provider={row.id} />
            <div class="min-w-0 flex-1 space-y-0.5">
              <h3 class="flex min-h-5 items-center text-sm font-medium tracking-[-0.005em] text-foreground">
                {row.label}
                <ProviderConnectedCheck connected={row.state === "done"} provider={row.label} />
              </h3>
              <p class="text-pretty text-[13px] leading-[1.45] text-(--solus-text-secondary)">
                {row.detail}
              </p>
            </div>
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-2">
            {#if row.state === "busy"}
              <CircleNotchIcon size={14} class="shrink-0 animate-spin text-muted-foreground" aria-label="Working" />
            {/if}
            {@render actions(row)}
          </div>
        </div>
      {/each}
    </RowCard>
  </div>
{/if}
