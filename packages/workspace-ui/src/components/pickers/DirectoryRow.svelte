<script lang="ts">
  import { ArrowElbowLeftUpIcon, FolderIcon, GitBranchIcon } from "phosphor-svelte";

  interface Props {
    id: string;
    name: string;
    /** The ".." row that walks one level up, rendered above the folders. */
    isUpRow?: boolean;
    selected: boolean;
    /** The folder is a git checkout — browsing an unfamiliar host stops being guesswork. */
    isRepo?: boolean;
    /** Checked-out branch, when the host could resolve one. */
    branch?: string;
    /** Solus already knows this folder as a project on this host. */
    isProject?: boolean;
    /** Absolute positioning handed down by the virtual list. */
    style?: string;
    onclick: () => void;
  }

  let {
    id,
    name,
    isUpRow = false,
    selected,
    isRepo = false,
    branch,
    isProject = false,
    style,
    onclick,
  }: Props = $props();
</script>

<button
  type="button"
  {id}
  {style}
  class="mx-2 flex h-8 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md border-0 px-2.5 text-left max-md:h-12
    [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
    {selected ? 'bg-muted' : 'bg-transparent hover:bg-muted'}"
  role="option"
  aria-selected={selected}
  tabindex={-1}
  {onclick}
>
  {#if isUpRow}
    <ArrowElbowLeftUpIcon size={13} class="shrink-0 text-muted-foreground" />
    <span class="flex-1 truncate font-mono text-xs text-muted-foreground">{name}</span>
  {:else}
    <!-- A checkout is the thing you are usually looking for, so it is the one
         row that carries the accent. -->
    {#if isRepo}
      <GitBranchIcon size={13} class="shrink-0 text-primary" />
    {:else}
      <FolderIcon size={13} class="shrink-0 text-muted-foreground" />
    {/if}
    <span class="min-w-0 shrink truncate text-[0.8125rem]">{name}</span>
    {#if branch}
      <span class="shrink-0 truncate font-mono text-xs text-muted-foreground" title="On branch {branch}">
        {branch}
      </span>
    {/if}
    {#if isProject}
      <span class="shrink-0 text-xs text-muted-foreground">Project</span>
    {/if}
  {/if}
</button>
