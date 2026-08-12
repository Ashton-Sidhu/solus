<script lang="ts">
  import { CaretDownIcon, XIcon } from "phosphor-svelte";
  import ProjectMark from "./ProjectMark.svelte";
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
  }
  let {
    label,
    count,
    scopedProject = null,
    projectChoices = [],
    onFilter,
    showLabel = true,
  }: Props = $props();

  let triggerEl: HTMLButtonElement | undefined = $state();
  let menuOpen = $state(false);
</script>

<!-- The label starts on the same 10px inset every other row's content does, so
     the column keeps one left edge from the new-task bar down to the footer.

     The filter band drops to the list's own 14px inset instead, because it is
     not a label over the list: its text is the first line you read in the
     column. It carries a task row's exact leading pair — 14px of container,
     2px inside the plate — so the words land on the title rule and the hover
     wash starts on the same edge every row's does. -->
<div
  class="flex flex-shrink-0 items-center {showLabel
    ? 'h-[2.625rem] gap-[0.5625rem] px-6'
    : 'h-[2.125rem] pr-[1.125rem] pl-3.5'}"
>
  {#if showLabel}
    <span
      class="overflow-hidden text-xs font-medium text-ellipsis whitespace-nowrap text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] uppercase"
      >{label}</span
    >
    <!-- A pill rather than a bare figure: it is the total the section is named
         for, not a per-row count, so it reads as part of the label. -->
    <span
      class="rounded-full bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] px-1.5 py-0.5 font-mono text-xs text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] tabular-nums"
      >{count}</span
    >
  {/if}
  {#if onFilter}
    <!-- At rest this states the contents of the list in grey text — no plate,
         no ring. Full ink, the project's own mark and a way out appear only
         once it is doing something. -->
    <button
      bind:this={triggerEl}
      type="button"
      class="flex h-6 cursor-pointer items-center gap-[0.3125rem] rounded-[0.4375rem] pr-[0.4375rem] pl-[0.125rem] transition-[background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring {menuOpen
        ? 'bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)]'
        : ''}"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title={scopedProject?.projectKey ?? undefined}
      onclick={() => (menuOpen = !menuOpen)}
    >
      {#if scopedProject}
        <ProjectMark
          projectKey={scopedProject.projectKey}
          initial={scopedProject.initial}
          active={false}
          class="size-[0.6875rem]"
          letterClass="text-[0.5rem]"
        />
      {/if}
      <span
        class="max-w-[10.5rem] overflow-hidden text-xs tracking-[-0.004em] text-ellipsis whitespace-nowrap {scopedProject
          ? 'text-foreground'
          : 'text-[color-mix(in_oklch,var(--foreground)_62%,transparent)]'}"
        >{scopedProject ? scopedProject.label : "All projects"}</span
      >
      <CaretDownIcon size={11} class="shrink-0 opacity-50" />
    </button>
    {#if scopedProject}
      <!-- The only way out, and it does not wait for hover: the band is where
           you find out you are scoped, so it is where you stop being. -->
      <button
        type="button"
        class="ml-auto flex size-[1.375rem] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        title="Clear filter"
        aria-label="Show tasks from all projects"
        onclick={() => onFilter(null)}
      >
        <XIcon size={12} weight="bold" />
      </button>
    {/if}
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
