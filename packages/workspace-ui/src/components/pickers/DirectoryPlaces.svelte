<script lang="ts">
  import {
    Folder as FolderIcon,
    House as HouseIcon,
    History as ClockCounterClockwiseIcon,
  } from "@lucide/svelte";
  import type { Place, PlaceIcon } from "./lib/picker-places";

  interface Props {
    locations: Place[];
    /** Recent projects on the browsed host, already in its path form. */
    recents: Array<{ label: string; path: string }>;
    /** The typed path; the place it equals reads as current. */
    activePath: string;
    onNavigate: (path: string) => void;
  }

  let { locations, recents, activePath, onNavigate }: Props = $props();
</script>

<nav
  class="flex w-49 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-r-border p-2"
  aria-label="Places"
>
  {#snippet place(label: string, target: string, icon: PlaceIcon)}
    <button
      type="button"
      class="flex h-[1.875rem] w-full shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-[0.8125rem] outline-none
        [transition:background-color_var(--duration-quick)_var(--ease-premium),color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
        focus-visible:ring-2 focus-visible:ring-(--solus-accent)
        {activePath === target
          ? 'bg-secondary text-primary'
          : icon === 'recent'
            ? 'text-muted-foreground hover:bg-muted'
            : 'hover:bg-muted'}"
      onclick={() => onNavigate(target)}
      title={target}
    >
      {#if icon === "home"}
        <HouseIcon size={14} class="shrink-0" />
      {:else if icon === "recent"}
        <ClockCounterClockwiseIcon size={14} class="shrink-0" />
      {:else}
        <FolderIcon size={14} class="shrink-0" />
      {/if}
      <span class="truncate">{label}</span>
    </button>
  {/snippet}

  {#each locations as loc (loc.path)}
    {@render place(loc.label, loc.path, loc.icon)}
  {/each}

  <div class="my-2 h-px shrink-0 bg-border"></div>

  {#each recents as recent (recent.path)}
    {@render place(recent.label, recent.path, "recent")}
  {/each}
</nav>
