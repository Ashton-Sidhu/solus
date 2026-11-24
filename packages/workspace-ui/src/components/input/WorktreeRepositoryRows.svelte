<script lang="ts">
  import { Check as CheckIcon, FolderGit2 as RepositoryIcon } from "@lucide/svelte";
  import * as Command from "../ui/command";
  import { matchesSearch } from "../../lib/search-match";
  import {
    withWorktreeRepository,
    type WorktreeRepositoryChoice,
  } from "./lib/worktree-repositories";

  /** The repositories of the run's codebase that get a worktree with the new
   *  worktree of the run. Rendered inside the start control's `Command.List`,
   *  so the arrow keys reach each row and Enter changes it. */
  interface Props {
    choice: WorktreeRepositoryChoice;
    /** The search text of the menu: the rows filter themselves. */
    query: string;
    onChoose: (paths: string[]) => void;
  }
  let { choice, query, onChoose }: Props = $props();

  const showsWorking = $derived(
    choice.working.isRepository && matchesSearch(`worktree repository ${choice.working.name}`, query),
  );
  const shownRows = $derived(
    choice.rows.filter((row) => matchesSearch(`worktree repository ${row.name} ${row.path}`, query)),
  );
</script>

{#if showsWorking || shownRows.length > 0}
  <Command.Group heading="Repositories with a worktree">
    {#if showsWorking}
      <!-- The run starts in this repository, so it always gets its worktree. -->
      <Command.Item
        value="worktree repository {choice.working.name} {choice.working.path}"
        disabled
        title={choice.working.path}
        class="menu-item-stagger"
      >
        <RepositoryIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
        <span class="min-w-0 flex-1 truncate">{choice.working.name}</span>
        <span class="shrink-0 text-xs text-(--solus-text-tertiary)">Working folder</span>
        <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
      </Command.Item>
    {/if}
    {#each shownRows as row (row.path)}
      <Command.Item
        value="worktree repository {row.name} {row.path}"
        disabled={!!row.refusal}
        title={row.refusal?.reason ?? row.path}
        aria-label={row.refusal
          ? `${row.name}: ${row.refusal.reason}`
          : `${row.name}: ${row.isChosen ? "gets a worktree" : "gets no worktree"}`}
        onSelect={() => onChoose(withWorktreeRepository(choice, row.path, !row.isChosen))}
        data-menu-current={row.isChosen ? "" : undefined}
        class="menu-item-stagger"
      >
        <RepositoryIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
        <span class="min-w-0 flex-1 truncate">{row.name}</span>
        {#if row.refusal}
          <span class="shrink-0 text-xs text-(--solus-text-tertiary)">{row.refusal.mark}</span>
        {:else if row.isChosen}
          <CheckIcon size={12} class="shrink-0 text-(--solus-accent)" />
        {/if}
      </Command.Item>
    {/each}
    {#if choice.note}
      <p class="text-pretty px-2.5 pb-1 text-xs leading-snug text-(--solus-text-tertiary)">
        {choice.note}
      </p>
    {/if}
  </Command.Group>
{/if}
