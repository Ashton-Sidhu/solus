<script lang="ts">
  import type { Snippet } from "svelte";
  import { Funnel as FunnelIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ListProjectRows from "../ui/list-page/ListProjectRows.svelte";
  import type { ProjectFilterChoice } from "./lib/task-list";

  interface Props {
    /** The project scope, when one is set. */
    scopedProject?: ProjectFilterChoice | null;
    projectChoices?: ProjectFilterChoice[];
    onFilter?: (projectKey: string | null) => void;
    leading?: Snippet;
    trailing?: Snippet;
  }
  let {
    scopedProject = null,
    projectChoices = [],
    onFilter,
    leading,
    trailing,
  }: Props = $props();

  let menuOpen = $state(false);
  let menuEl: HTMLElement | null = $state(null);
</script>

<!-- The task list carries no section label. This bar holds its actions instead:
     filtering and search are optional work, not a standing heading that competes
     with the tasks it scopes. -->
<div
  class="flex h-8 flex-shrink-0 items-center gap-1 px-3.5 @max-[15rem]:px-2.5"
>
  {#if leading}
    <span class="min-w-0 flex-1">{@render leading()}</span>
  {/if}
  {#if onFilter || trailing}
    <span class="ml-auto flex shrink-0 items-center gap-0.5 pointer-coarse:gap-1">
      {#if onFilter}
        <DropdownMenu.Root bind:open={menuOpen}>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="relative flex size-6 cursor-pointer items-center justify-center rounded-lg transition-[background-color,box-shadow,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-7 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-10 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] {menuOpen
                  ? 'bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] text-foreground'
                  : scopedProject
                    ? 'text-primary'
                    : 'text-muted-foreground'}"
                aria-label={scopedProject
                  ? `Filter tasks by project. Current filter: ${scopedProject.label}`
                  : "Filter tasks by project"}
                title={scopedProject
                  ? `Project: ${scopedProject.label}`
                  : "Filter by project"}
              >
                <FunnelIcon class="size-4" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <!-- A long project list opens to its find field, the way the list
               pages' Project group does. -->
          <DropdownMenu.Content
            bind:ref={menuEl}
            side="bottom"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            aria-label="Filter tasks by project"
            class="flex max-h-[min(32rem,calc(var(--bits-dropdown-menu-content-available-height,36rem)-1rem))] w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-2"
            onOpenAutoFocus={(event) => {
              const find = menuEl?.querySelector<HTMLInputElement>("[data-project-find]");
              if (!find) return;
              event.preventDefault();
              find.focus();
            }}
          >
            <ListProjectRows
              projects={projectChoices}
              activeKey={scopedProject?.key ?? ""}
              onSelectAll={() => onFilter(null)}
              onSelect={(option) => onFilter(option.key)}
            />
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
      {#if trailing}
        {@render trailing()}
      {/if}
    </span>
  {/if}
</div>
