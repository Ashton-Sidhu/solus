<script lang="ts">
  import { groupKeyFor } from "../../../contexts";
  import ProjectFavicon from "../../ui/ProjectFavicon.svelte";
  import type { RepositoryChange } from "../../conversation/lib/change-repositories";
  import LineCounts from "./LineCounts.svelte";

  /**
   * The share of each repository in a change, over the Changes card's tree
   * (docs/plans/codebases.md §8). The rows show only when more than one
   * repository holds the change. A row opens the diff pane on its repository.
   */
  interface Props {
    repositories: readonly RepositoryChange[];
    /** The host of the session: each repository's project mark is read there. */
    serverId: string;
    /** Opens the diff of one repository. Absent when the session has no conversation open to show it in. */
    onOpen?: (repositoryPath: string) => void;
  }
  let { repositories, serverId, onOpen }: Props = $props();
</script>

<div class="flex flex-col gap-px pb-1" role="group" aria-label="Changes by repository" data-testid="artifacts-change-repositories">
  {#each repositories as repository (repository.repositoryPath)}
    <button
      type="button"
      title={onOpen ? `Open the diff of ${repository.name}\n${repository.repositoryPath}` : repository.repositoryPath}
      disabled={!onOpen}
      class="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg border-0 bg-transparent pr-2 pl-2 text-left text-workspace-chrome text-foreground transition-colors duration-(--duration-base) ease-(--ease-premium) hover:bg-[var(--wash-2)] focus-visible:outline-2 focus-visible:outline-(--solus-accent-border-medium) disabled:cursor-default disabled:hover:bg-transparent pointer-coarse:h-11"
      data-testid="artifacts-change-repository"
      onclick={() => onOpen?.(repository.repositoryPath)}
    >
      <!-- Stands in for the disclosure column, so the icon is in the tree's icon column. -->
      <span class="w-3 shrink-0"></span>
      <ProjectFavicon projectKey={groupKeyFor(serverId, repository.repositoryPath)} class="size-4" />
      <span class="min-w-0 shrink truncate">{repository.name}</span>
      <span class="shrink-0 text-xs tabular-nums text-muted-foreground opacity-70">
        {repository.filesChanged} file{repository.filesChanged === 1 ? "" : "s"}
      </span>
      <span class="flex-1"></span>
      <LineCounts columns additions={repository.additions} deletions={repository.deletions} />
    </button>
  {/each}
</div>
