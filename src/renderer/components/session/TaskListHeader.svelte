<script lang="ts">
  import { ListIcon, TreeViewIcon, XIcon } from "phosphor-svelte";
  import type { SidebarViewMode } from "../../contexts/app/settings.context.svelte";

  interface Props {
    label: string;
    count: number;
    mode: SidebarViewMode;
    /** A toggle over one project's worth of tasks has nothing to switch. */
    showToggle: boolean;
    /** While a filter is on, the ✕ beside the count is the one way out. */
    filtered: boolean;
    onModeChange: (mode: SidebarViewMode) => void;
    onClearFilter: () => void;
  }
  let {
    label,
    count,
    mode,
    showToggle,
    filtered,
    onModeChange,
    onClearFilter,
  }: Props = $props();

  // Selection, disclosure and scroll all survive a mode switch, so the toggle
  // is a lens over the same list rather than a second screen — which is why it
  // is two bare glyphs rather than a segmented plate. Ink alone says which is on.
  const segment =
    "flex size-5 cursor-pointer items-center justify-center rounded transition-[background,color] duration-150 hover:bg-accent";
</script>

<!-- The section label sits one step out from the spine, on the nav icons'
     column: it is the level above the titles, so it starts where their icons
     do rather than where their labels do. -->
<div class="flex h-[2.125rem] flex-shrink-0 items-center gap-[0.4375rem] pr-2.5 pl-[1.375rem]">
  <span
    class="overflow-hidden text-[0.59375rem] font-semibold tracking-[0.1em] text-ellipsis whitespace-nowrap text-muted-foreground uppercase"
    >{label}</span
  >
  <span
    class="font-mono text-[0.625rem] text-muted-foreground opacity-45 tabular-nums"
    >{count}</span
  >
  {#if filtered}
    <button
      class="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[0.1875rem] text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground"
      data-clear-project-filter
      title="Show all tasks"
      aria-label="Show all tasks"
      onclick={onClearFilter}
    >
      <XIcon size={8} weight="bold" />
    </button>
  {/if}
  {#if showToggle}
    <div
      class="ml-auto flex items-center gap-0.5"
      role="group"
      aria-label="Task list view"
    >
      <button
        class="{segment} {mode === 'flat'
          ? 'text-foreground'
          : 'text-muted-foreground/70'}"
        title="Flat list"
        aria-pressed={mode === "flat"}
        aria-label="Flat list"
        onclick={() => onModeChange("flat")}
      >
        <ListIcon size={13} />
      </button>
      <button
        class="{segment} {mode === 'grouped'
          ? 'text-foreground'
          : 'text-muted-foreground/70'}"
        title="Group by project"
        aria-pressed={mode === "grouped"}
        aria-label="Group by project"
        onclick={() => onModeChange("grouped")}
      >
        <TreeViewIcon size={13} />
      </button>
    </div>
  {/if}
</div>
