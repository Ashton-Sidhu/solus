<script lang="ts">
  import { Check as CheckIcon, ChevronDown as CaretDownIcon, Layers as LayersIcon } from "@lucide/svelte";
  import type { TaskSourceState } from "@solus/contracts/task-types";
  import { taskSourceProvider } from "@solus/contracts/task-sources";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { SourceLogo } from "../ui/list-page";

  /**
   * Which task source the Tasks page plots: one source of the project, with
   * the provider's own columns, or every source together, grouped by status
   * category (docs/plans/provider-owned-tasks.md §7).
   */
  interface Props {
    sources: TaskSourceState[];
    /** The source on screen. Null = all sources. */
    sourceKey: string | null;
    onSelect: (sourceKey: string | null) => void;
  }
  let { sources, sourceKey, onSelect }: Props = $props();

  const current = $derived(sources.find((source) => source.sourceKey === sourceKey) ?? null);
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class="flex h-8 min-w-0 shrink cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border-0 bg-[var(--wash-2)] px-2.5 text-foreground transition-colors duration-150 hover:bg-[var(--wash-3)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] @max-[30rem]/pane:h-10"
        aria-label="Task source on screen"
        title={current
          ? `${current.label}: the provider's columns`
          : "All sources: grouped by status category"}
      >
        {#if current}
          <SourceLogo source={taskSourceProvider(current.source)} />
        {:else}
          <LayersIcon size={13} class="shrink-0 opacity-75" />
        {/if}
        <span class="truncate">{current?.label ?? "All sources"}</span>
        <CaretDownIcon size={9} class="shrink-0 opacity-60" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" sideOffset={6} class="w-[min(16rem,calc(100vw-2rem))]">
    <DropdownMenu.Item onSelect={() => onSelect(null)}>
      <LayersIcon size={13} class="shrink-0 opacity-75" />
      <span class="min-w-0 flex-1 truncate">All sources</span>
      {#if !current}
        <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
      {/if}
    </DropdownMenu.Item>
    {#each sources as source (source.sourceKey)}
      <DropdownMenu.Item onSelect={() => onSelect(source.sourceKey)}>
        <SourceLogo source={taskSourceProvider(source.source)} />
        <span class="min-w-0 flex-1 truncate">{source.label}</span>
        {#if source.sourceKey === current?.sourceKey}
          <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
        {/if}
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
