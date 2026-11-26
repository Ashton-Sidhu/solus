<script lang="ts">
  /** The "+" in the header of the Git card: one more repository for the
   *  session. Each started session that this person may change has it; what
   *  it does depends on where the session works (`addRepositoryPlace`): a
   *  worktree in a task folder, a chosen folder in a project folder, and a
   *  note in a single worktree, which holds no second repository. */
  import { Plus as PlusIcon } from "@lucide/svelte";
  import type { SessionFolder } from "@solus/contracts/codebases";
  import { getSessionEnvironmentStore, getWorkspaceContext, groupKeyFor } from "../../contexts";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import { addRepositoryPlace, addRepositoryTooltip, candidateRows, SINGLE_WORKTREE_NOTE } from "./lib/git-repositories";
  import { addSessionFolder, errorText } from "./lib/repository-actions";

  interface Props {
    /** The tab or draft whose run the Git card describes: see `ProjectPanel`. */
    sourceId: string;
  }
  let { sourceId }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const serverId = $derived(session.serverIdFor(sourceId));
  const panelSession = $derived(session.sessionFor(sourceId));
  const env = $derived(environmentStore.environmentFor(session.runFor(sourceId)));
  const place = $derived(
    panelSession && hasSessionStarted(panelSession) && canDriveSession(serverId, panelSession.id)
      ? addRepositoryPlace(env.cwd)
      : null,
  );

  // The repositories of a task folder session that have no worktree there. Read when the menu opens.
  let isOpen = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let candidates = $state<{ state: "loading" | "ready" | "error"; rows: { path: string; name: string }[]; error: string | null }>({ state: "loading", rows: [], error: null });
  let candidatesRead = 0;
  let isAdding = $state(false);

  function activate(event: MouseEvent) {
    // The header toggles its section on a click: this click is the button's alone.
    event.stopPropagation();
    // A session in its project folder reaches the original of each repository: the person chooses one.
    if (place === "folder") addSessionFolder(session, sourceId);
    else void openMenu();
  }

  async function openMenu() {
    const sessionId = panelSession?.id;
    if (isOpen || !sessionId) {
      isOpen = false;
      return;
    }
    isOpen = true;
    // One worktree inside its repository holds no second one: the menu says so, and reads nothing.
    if (place === "worktree") return;
    candidates = { state: "loading", rows: [], error: null };
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

  async function addWorktree(repositoryPath: string) {
    isOpen = false;
    const sessionId = panelSession?.id;
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

{#if place}
  <button
    bind:this={button}
    class="add-repository"
    class:is-busy={isAdding}
    type="button"
    aria-label="Add repository"
    title={addRepositoryTooltip(place)}
    aria-haspopup={place === "folder" ? "dialog" : "menu"}
    aria-expanded={place === "folder" ? undefined : isOpen}
    disabled={isAdding}
    onclick={activate}
  >
    <PlusIcon size={12} />
  </button>

  <DropdownMenu.Root bind:open={isOpen}>
    <DropdownMenu.Content
      customAnchor={button}
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="w-64"
      onInteractOutside={(event) => {
        // The button toggles the menu itself; do not close and reopen here.
        if (button?.contains(event.target as Node | null)) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        requestInputFocus({ tabId: sourceId });
      }}
    >
      {#if place === "worktree"}
        <DropdownMenu.Item disabled class="whitespace-normal">{SINGLE_WORKTREE_NOTE}</DropdownMenu.Item>
      {:else if candidates.state === "loading"}
        <DropdownMenu.Item disabled>Reading the repositories…</DropdownMenu.Item>
      {:else if candidates.state === "error"}
        <DropdownMenu.Item disabled class="whitespace-normal">{candidates.error}</DropdownMenu.Item>
      {:else if candidates.rows.length === 0}
        <DropdownMenu.Item disabled class="whitespace-normal">Each repository of this session that can get a worktree has one.</DropdownMenu.Item>
      {:else}
        {#each candidates.rows as candidate (candidate.path)}
          <DropdownMenu.Item title={candidate.path} onSelect={() => void addWorktree(candidate.path)}>
            <ProjectFavicon projectKey={groupKeyFor(serverId, candidate.path)} class="size-4" />
            <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
          </DropdownMenu.Item>
        {/each}
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<style>
  /* The icon buttons of the Environment header (`ProjectPanel` `.tiny-icon`). */
  .add-repository {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      color 0.15s ease,
      background-color 0.15s ease;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    flex-shrink: 0;
  }
  .add-repository:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }
  .add-repository:active {
    background: color-mix(in srgb, var(--solus-accent) 12%, transparent);
  }
  .add-repository:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .add-repository.is-busy {
    cursor: progress;
    opacity: 0.6;
  }
</style>
