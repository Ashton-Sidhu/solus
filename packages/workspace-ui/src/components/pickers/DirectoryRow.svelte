<script lang="ts">
  import { CornerLeftUp as ArrowElbowLeftUpIcon, Folder as FolderIcon, GitBranch as GitBranchIcon } from "@lucide/svelte";
  import { worktreeDisplayName } from "../../lib/git-context";

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
  class="mx-2 flex h-8 w-[calc(100%-1rem)] items-center gap-2.5 rounded-md border-0 px-2.5 text-left
    max-md:h-13 max-md:gap-[0.6875rem] max-md:rounded-[0.875rem] max-md:px-3
    [transition:background-color_var(--duration-quick)_var(--ease-premium)] motion-reduce:transition-none
    {selected ? 'bg-muted' : 'bg-transparent hover:bg-muted'}"
  role="option"
  aria-selected={selected}
  tabindex={-1}
  {onclick}
>
  {#if isUpRow}
    <ArrowElbowLeftUpIcon size={13} class="shrink-0 text-muted-foreground max-md:size-4" />
    <span class="flex-1 truncate font-mono text-xs text-muted-foreground max-md:text-[0.8125rem]">{name}</span>
  {:else}
    <!-- A checkout is the thing you are usually looking for, so it is the one
         row that carries the accent. -->
    {#if isRepo}
      <GitBranchIcon size={13} class="shrink-0 text-primary max-md:size-4" />
    {:else}
      <FolderIcon size={13} class="shrink-0 text-muted-foreground max-md:size-4" />
    {/if}
    <span class="min-w-0 shrink truncate text-[0.8125rem] max-md:text-sm max-md:font-medium max-md:tracking-[-0.005em]">{name}</span>
    {#if branch}
      <span
        class="shrink-0 truncate font-mono text-xs text-muted-foreground max-md:text-[0.6875rem]"
        title="On branch {worktreeDisplayName(branch)}"
      >
        {worktreeDisplayName(branch)}
      </span>
    {/if}
    {#if isProject}
      <!-- A folder Solus already tracks is a different kind of thing, not a
           quieter one: on a phone it takes the accent pill the spec gives it,
           where the desktop's muted word beside a 13px name would be lost. -->
      <span
        class="shrink-0 text-xs text-muted-foreground
          max-md:rounded-full max-md:bg-[color-mix(in_oklch,var(--primary)_13%,transparent)]
          max-md:px-2 max-md:py-0.5 max-md:text-[0.65625rem] max-md:font-medium max-md:tracking-[0.03em]
          max-md:text-[color-mix(in_oklch,var(--primary)_82%,var(--foreground))]"
      >
        Project
      </span>
    {/if}
  {/if}
</button>
