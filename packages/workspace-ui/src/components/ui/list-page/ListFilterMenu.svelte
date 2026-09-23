<script lang="ts">
  import type { Snippet } from "svelte";
  import { ListFilter as ListFilterIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../dropdown-menu";
  import { useScope } from "../../../lib/keybindings/use-keybinding.svelte";

  let { activeCount = 0, children }: { activeCount?: number; children: Snippet } = $props();
  let open = $state(false);
  useScope("list-filters", { exclusive: true, active: () => open });
</script>

  <DropdownMenu.Root bind:open={open}>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="relative flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 shadow-[shadow:var(--elev-ring)] hover:bg-[var(--wash-1)] @min-[40rem]/pane:pr-3 @max-[30rem]/pane:h-10 bg-card text-foreground data-[state=open]:bg-[var(--wash-1)]"
          aria-label={activeCount > 0
            ? `Filters (${activeCount} active)`
            : "Filters"}
          title="Filters"
        >
          <ListFilterIcon size={16} class="shrink-0 text-muted-foreground" />
          <span class="@max-[40rem]/pane:hidden">Filters</span>
          {#if activeCount > 0}
            <!-- The count is the only sign of a narrowed list, so it shows at every width. -->
            <span class="text-xs text-muted-foreground tabular-nums">{activeCount}</span>
          {/if}
          <span
            class="pointer-events-none absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
            aria-hidden="true"
          ></span>
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <!-- Reserve the widest submenu to the right of this column. Without the
         alignment offset, the filter trigger sits at the window edge
         and Floating UI correctly flips every submenu to the left. -->
    <DropdownMenu.Content
      side="bottom"
      align="end"
      alignOffset={400}
      sideOffset={6}
      class="w-64 pointer-fine:[.is-laptop-display_&]:w-56"
    >
      {@render children()}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
