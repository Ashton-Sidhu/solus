<script lang="ts">
  /** The repositories of the Git card: one row for each repository that the
   *  session works in, as the card shows one row for each linked pull request.
   *  A choice of a row makes it the repository that the Git rows below work
   *  in. The "+" in the header of the card adds one more
   *  (`AddRepositoryButton`). */
  import { FolderGit2 as RepositoryIcon, GitFork as WorktreeIcon } from "@lucide/svelte";
  import { getSessionEnvironmentStore, getWorkspaceContext, groupKeyFor } from "../../contexts";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import MenuRow from "./MenuRow.svelte";
  import {
    gitRepositoryReading,
    gitRepositoryRowLabel,
    type GitRepositoryFold,
    type GitRepositoryRow,
  } from "./lib/git-repositories";
  import { useGitRepositoryReads } from "./lib/git-repository-reads.svelte";

  interface Props {
    /** The tab or draft whose run this card describes: see `ProjectPanel`. */
    sourceId: string;
    /** Hidden mounted tabs and a closed project panel must not read the host. */
    active: boolean;
    /** The rows that show, and the row that opens or closes the rest of a long list (`foldGitRepositoryRows`). */
    fold: GitRepositoryFold;
    /** The row that the Git rows work in. Null for a draft: its rows open their files, and no row is the chosen one. */
    chosenKey: string | null;
    onChoose: (row: GitRepositoryRow) => void;
    onToggleFold: () => void;
  }
  let { sourceId, active, fold, chosenKey, onChoose, onToggleFold }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const serverId = $derived(session.serverIdFor(sourceId));

  useGitRepositoryReads({
    get active() { return active; },
    get serverId() { return serverId; },
    // A row that the fold hides shows no Git state, so it reads none.
    get pathsKey() { return fold.visible.map((row) => row.path).join("\n"); },
    environment: environmentStore,
  });
</script>

<div class="flex flex-col gap-px" role="group" aria-label="Repositories">
  {#each fold.visible as row (row.key)}
    {@const reading = gitRepositoryReading(row, environmentStore.statusFor(serverId, row.path))}
    {@const isChosen = row.key === chosenKey}
    <!-- The mark of the repository's project: a worktree wears the mark of the repository it checks out. -->
    {#snippet repositoryFavicon()}
      <ProjectFavicon projectKey={groupKeyFor(serverId, row.repositoryPath)} class="size-4" />
    {/snippet}
    <MenuRow
      item={{
        key: row.key,
        label: row.name,
        icon: row.isIsolated ? WorktreeIcon : RepositoryIcon,
        phase: "idle",
        diffStat: reading.diffStat,
        badge: reading.badge,
        tooltip: reading.tooltip,
      }}
      ariaLabel={chosenKey === null ? `${row.name}: open its files` : gitRepositoryRowLabel(row, isChosen)}
      current={isChosen}
      iconSnippet={repositoryFavicon}
      onActivate={() => onChoose(row)}
    />
  {/each}
  <!-- A long list folds as the other linked pull requests of the card do. -->
  {#if fold.toggleLabel}
    <div class="flex items-center px-1.5 pt-0.5 text-chrome-dense text-(--solus-text-tertiary)">
      <button
        type="button"
        class="cursor-pointer rounded py-1 hover:text-(--solus-text-primary) focus-visible:outline-2"
        aria-expanded={fold.isExpanded}
        onclick={onToggleFold}
      >{fold.toggleLabel}</button>
    </div>
  {/if}
  <!-- The same hairline that sets the other linked pull requests apart: the Git rows of the chosen repository follow. -->
  <div class="mx-2 mt-1.5 mb-1 h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]" aria-hidden="true"></div>
</div>
