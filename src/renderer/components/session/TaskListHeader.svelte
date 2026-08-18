<script lang="ts">
  import type { Snippet } from "svelte";
  import { FunnelIcon } from "phosphor-svelte";
  import ProjectFilterMenu from "./ProjectFilterMenu.svelte";
  import type { ProjectFilterChoice } from "./lib/task-list";

  interface Props {
    label: string;
    count: number;
    /** The project scope, for a section that has one. The drafts section does
     *  not: a draft that belongs to no project yet is listed under every
     *  scope, so there is nothing here for it to state. */
    scopedProject?: ProjectFilterChoice | null;
    projectChoices?: ProjectFilterChoice[];
    onFilter?: (projectKey: string | null) => void;
    showLabel?: boolean;
    leading?: Snippet;
    trailing?: Snippet;
  }
  let {
    label,
    count,
    scopedProject = null,
    projectChoices = [],
    onFilter,
    showLabel = true,
    leading,
    trailing,
  }: Props = $props();

  let triggerEl: HTMLButtonElement | undefined = $state();
  let menuOpen = $state(false);
</script>

<!-- Section labels keep their established treatment. The task section uses a
     compact action bar instead: filtering is an optional action, not a standing
     row that competes with the tasks it scopes. -->
<div
  class="flex flex-shrink-0 items-center {showLabel
    ? 'h-[2.625rem] gap-[0.5625rem] px-6 @max-[15rem]:px-5'
    : 'h-8 gap-1 px-3.5 [.is-laptop-display_&]:h-7 pointer-coarse:h-8 @max-[15rem]:px-2.5'}"
>
  {#if showLabel}
    <span
      class="overflow-hidden text-xs font-medium text-ellipsis whitespace-nowrap text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] uppercase"
      >{label}</span
    >
    <span
      class="rounded-full bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] px-1.5 py-0.5 text-xs text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] tabular-nums"
      >{count}</span
    >
  {/if}
  {#if leading}
    <span class="min-w-0 flex-1">{@render leading()}</span>
  {/if}
  {#if onFilter || trailing}
    <span class="ml-auto flex shrink-0 items-center gap-1">
      {#if onFilter}
        <button
          bind:this={triggerEl}
          type="button"
          class="relative flex size-7 cursor-pointer items-center justify-center rounded-lg transition-[background-color,box-shadow,color,scale] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:scale-[0.96] [.is-laptop-display_&]:size-6 pointer-coarse:size-7 pointer-coarse:before:absolute pointer-coarse:before:left-1/2 pointer-coarse:before:top-1/2 pointer-coarse:before:size-10 pointer-coarse:before:-translate-x-1/2 pointer-coarse:before:-translate-y-1/2 pointer-coarse:before:content-[''] {menuOpen
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
            size={15}
            weight={scopedProject ? "fill" : "regular"}
            class="[.is-laptop-display_&]:size-[13px] pointer-coarse:size-[15px]"
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
