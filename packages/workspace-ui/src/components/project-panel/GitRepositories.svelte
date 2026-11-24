<script lang="ts">
  /** The repositories of the Git card: one row for each repository that the
   *  session works in, as the card shows one row for each linked pull request.
   *  A choice of a row makes it the repository that the Git rows below work
   *  in. "Add repository" gives a task folder session one more worktree. */
  import { FolderGit2 as RepositoryIcon, GitFork as WorktreeIcon } from "@lucide/svelte";
  import type { SessionFolder } from "@solus/contracts/codebases";
  import { getSessionEnvironmentStore, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import MenuRow from "./MenuRow.svelte";
  import {
    candidateRows,
    gitRepositoryReading,
    gitRepositoryRowLabel,
    type GitRepositoryFold,
    type GitRepositoryRow,
  } from "./lib/git-repositories";
  import { useGitRepositoryReads } from "./lib/git-repository-reads.svelte";
  import { errorText } from "./lib/repository-actions";

  interface Props {
    /** The tab or draft whose run this card describes: see `ProjectPanel`. */
    sourceId: string;
    /** Hidden mounted tabs and a closed project panel must not read the host. */
    active: boolean;
    /** The rows that show, and the row that opens or closes the rest of a long list (`foldGitRepositoryRows`). */
    fold: GitRepositoryFold;
    /** The row that the Git rows work in. Null for a draft: its rows open their files, and no row is the chosen one. */
    chosenKey: string | null;
    /** The session works in a task folder, and this person may change it: the card offers one more repository. */
    canAddRepository: boolean;
    onChoose: (row: GitRepositoryRow) => void;
    onToggleFold: () => void;
  }
  let { sourceId, active, fold, chosenKey, canAddRepository, onChoose, onToggleFold }: Props = $props();

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

  // "Add repository" in a task folder session: the repositories of the session
  // that have no worktree in the task folder. Read when the menu opens.
  let candidatesOpen = $state(false);
  let candidatesAnchor = $state<HTMLElement | null>(null);
  let candidates = $state<{ state: "loading" | "ready" | "error"; rows: { path: string; name: string }[]; error: string | null }>({ state: "loading", rows: [], error: null });
  let candidatesRead = 0;
  let isAdding = $state(false);

  async function openCandidates(trigger: HTMLElement) {
    const sessionId = session.sessionFor(sourceId)?.id;
    if (candidatesOpen || !sessionId) {
      candidatesOpen = false;
      return;
    }
    candidatesAnchor = trigger;
    candidates = { state: "loading", rows: [], error: null };
    candidatesOpen = true;
    const read = ++candidatesRead;
    try {
      const answer = await session.apiFor(sourceId).sessionWorktreeCandidates(sessionId);
      if (read === candidatesRead) candidates = { state: "ready", rows: candidateRows(answer), error: null };
    } catch (error) {
      if (read === candidatesRead) candidates = { state: "error", rows: [], error: errorText(error) };
    }
  }

  /** The host's answer is the list now; its `session_folders` event says the same. One property changes. */
  function applyFolders(sessionId: string, next: SessionFolder[]) {
    const current = session.sessionFor(sourceId);
    if (current?.id === sessionId) current.sessionFolders = next;
  }

  async function addRepository(repositoryPath: string) {
    candidatesOpen = false;
    const sessionId = session.sessionFor(sourceId)?.id;
    if (isAdding || !sessionId) return;
    isAdding = true;
    try {
      // The host refuses a repository that cannot get a worktree here, with the reason.
      applyFolders(sessionId, await session.apiFor(sourceId).sessionAddRepositoryWorktree(sessionId, repositoryPath));
    } catch (error) {
      toasts.error("Couldn't add the repository", { description: errorText(error) });
    } finally {
      isAdding = false;
      requestInputFocus({ tabId: sourceId });
    }
  }
</script>

<div class="flex flex-col gap-px" role="group" aria-label="Repositories">
  {#each fold.visible as row (row.key)}
    {@const reading = gitRepositoryReading(row, environmentStore.statusFor(serverId, row.path))}
    {@const isChosen = row.key === chosenKey}
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
  {#if canAddRepository}
    <MenuRow
      item={{
        key: "add-repository",
        label: "Add repository…",
        icon: WorktreeIcon,
        phase: isAdding ? "loading" : "idle",
        tooltip: "Make a worktree of one more repository, on the branch of this session",
      }}
      onActivate={(event) => void openCandidates(event.currentTarget)}
    />
  {/if}
  <!-- The same hairline that sets the other linked pull requests apart: the Git rows of the chosen repository follow. -->
  <div class="mx-2 mt-1.5 mb-1 h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]" aria-hidden="true"></div>
</div>

<DropdownMenu.Root bind:open={candidatesOpen}>
  <DropdownMenu.Content
    customAnchor={candidatesAnchor}
    side="bottom"
    align="start"
    sideOffset={4}
    collisionPadding={8}
    class="w-(--bits-dropdown-menu-anchor-width) min-w-48"
    onInteractOutside={(event) => {
      // The row toggles the menu itself; do not close and reopen here.
      if (candidatesAnchor?.contains(event.target as Node | null)) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      requestInputFocus({ tabId: sourceId });
    }}
  >
    {#if candidates.state === "loading"}
      <DropdownMenu.Item disabled>Reading the repositories…</DropdownMenu.Item>
    {:else if candidates.state === "error"}
      <DropdownMenu.Item disabled class="whitespace-normal">{candidates.error}</DropdownMenu.Item>
    {:else if candidates.rows.length === 0}
      <DropdownMenu.Item disabled class="whitespace-normal">Each repository of this session that can get a worktree has one.</DropdownMenu.Item>
    {:else}
      {#each candidates.rows as candidate (candidate.path)}
        <DropdownMenu.Item title={candidate.path} onSelect={() => void addRepository(candidate.path)}>
          <RepositoryIcon />
          <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
        </DropdownMenu.Item>
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
