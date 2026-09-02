<script lang="ts">
  import type { Snippet } from "svelte";
  import { Funnel as FunnelIcon } from "@lucide/svelte";
  import ProjectFilterMenu from "./ProjectFilterMenu.svelte";
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

  let triggerEl: HTMLButtonElement | undefined = $state();
  let menuOpen = $state(false);
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
    <span class="ml-auto flex shrink-0 items-center gap-1">
      {#if onFilter}
        <button
          bind:this={triggerEl}
          type="button"
          class="relative flex size-7 pointer-fine:[.is-laptop-display_&]:size-6 cursor-pointer items-center justify-center rounded-lg transition-[background-color,box-shadow,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] pointer-coarse:size-7 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-10 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] {menuOpen
            ? 'bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] text-foreground'
            : scopedProject
              ? 'text-primary'
              : 'text-muted-foreground'}"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={scopedProject
            ? `Filter tasks by project. Current filter: ${scopedProject.label}`
            : "Filter tasks by project"}
          title={scopedProject
            ? `Project: ${scopedProject.label}`
            : "Filter by project"}
          onclick={() => (menuOpen = !menuOpen)}
        >
          <FunnelIcon
            size={12}
            weight={scopedProject ? "fill" : "regular"}
            class="pointer-fine:[.is-laptop-display_&]:size-[11px] pointer-coarse:size-[15px]"
          />
        </button>
      {/if}
      {#if trailing}
        {@render trailing()}
      {/if}
    </span>
  {/if}
</div>

{#if menuOpen && triggerEl && onFilter}
  <ProjectFilterMenu
    projectFilter={scopedProject?.projectKey ?? null}
    choices={projectChoices}
    anchor={triggerEl}
    onFilter={(projectKey) => {
      menuOpen = false;
      onFilter(projectKey);
    }}
    onClose={() => (menuOpen = false)}
  />
{/if}
