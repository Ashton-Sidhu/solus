<script lang="ts">
  import { untrack } from "svelte";
  import { Ellipsis as MoreIcon, FolderGit2 as RepositoryIcon, GitBranch as GitBranchIcon } from "@lucide/svelte";
  import { codebasesStore, getWorkspaceContext, getSessionEnvironmentStore, hosts } from "../../contexts";
  import { membersOnHost } from "../../contexts/codebases/host-members";
  import { codebaseOf } from "../../contexts/workspace/run-location";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import type { SessionFolderPlace } from "../../contexts/git/session-environment.store.svelte";
  import { Button } from "../ui/button";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import MenuRow, { PANEL_ROW_ICON_SIZE } from "./MenuRow.svelte";
  import { repositoriesInFolder, repositoriesInFolderLabel } from "./lib/git-setup";
  import { revealRepositories } from "./lib/repository-actions";

  interface Props {
    /** The tab or draft whose project this section describes. */
    sourceId: string;
    active: boolean;
    /** A session folder that this section describes, in place of the working directory of the run. */
    folder?: SessionFolderPlace | null;
  }
  let { sourceId, active, folder = null }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();

  const api = $derived(session.apiFor(sourceId));
  const serverId = $derived(serverConnections.serverIdForApi(api));
  const env = $derived(environmentStore.environmentIn(session.runFor(sourceId), folder));
  const cwd = $derived(env.cwd);

  const status = $derived(repositorySetupStore.statusFor(serverId, cwd));
  const canWriteGit = $derived(hosts.get(serverId)?.me.may("host.git.write") ?? true);
  const showInit = $derived(!!status && !status.isRepository);

  // A working directory with no repository can hold repositories: the session
  // folders of a started session, or what its host read for a draft. The
  // section then names them, and "Track with Git" is in the menu of the row.
  const run = $derived(session.runFor(sourceId));
  const panelSession = $derived(session.sessionFor(sourceId));
  const isStarted = $derived(!!panelSession && hasSessionStarted(panelSession));
  const codebaseId = $derived(codebaseOf(run));
  const draftMembers = $derived(
    folder || isStarted
      ? []
      : [
          ...(codebasesStore.projectScanAt(serverId, cwd)?.members ?? []),
          ...(codebaseId ? membersOnHost(codebasesStore.membersOf(codebaseId), serverId).members : []),
        ],
  );
  const repositoryCount = $derived(
    folder ? 0 : repositoriesInFolder(cwd, panelSession?.sessionFolders ?? [], draftMembers),
  );
  let folderMenuOpen = $state(false);
  let folderMenuAnchor = $state<HTMLElement | null>(null);

  function toggleFolderMenu(trigger: HTMLElement) {
    if (folderMenuOpen) {
      folderMenuOpen = false;
      return;
    }
    folderMenuAnchor = trigger.parentElement;
    folderMenuOpen = true;
  }

  /** A started session has the Repositories section. A draft has none yet, so its row opens the menu. */
  function showRepositories(trigger: HTMLElement) {
    if (!isStarted) {
      toggleFolderMenu(trigger);
      return;
    }
    revealRepositories(session.settings, sourceId === session.chatSurfaceTabId);
    requestInputFocus({ tabId: sourceId });
  }

  // One repository-status read per checkout, kept by the store across tab
  // switches; the manual Git refresh (ProjectPanel's header button) reads it again.
  $effect(() => {
    if (!active || !cwd || cwd === "~" || !api) return;
    const hostId = serverId;
    const checkout = cwd;
    const hostApi = api;
    untrack(() => repositorySetupStore.ensure(hostApi, hostId, checkout));
  });

  const initError = $derived(repositorySetupStore.initErrorFor(serverId, cwd));
  const initializing = $derived(repositorySetupStore.isInitializing(serverId, cwd));

  async function initializeGit() {
    if (!api) return;
    const ok = await repositorySetupStore.initialize(api, serverId, cwd);
    if (!ok) {
      toasts.error("Couldn't initialize Git", {
        description: repositorySetupStore.initErrorFor(serverId, cwd) ?? undefined,
      });
    }
    requestInputFocus();
  }
</script>

{#if showInit && repositoryCount > 0}
  <div class="flex min-w-0 items-stretch gap-px">
    <MenuRow
      split
      item={{
        key: "folder-repositories",
        label: repositoriesInFolderLabel(repositoryCount),
        icon: RepositoryIcon,
        phase: initializing ? "loading" : "idle",
        tooltip: isStarted
          ? "This folder is not a repository. Show the repositories of the session."
          : "This folder is not a repository. The Repositories section shows its repositories when the session starts.",
      }}
      ariaLabel={isStarted
        ? `${repositoriesInFolderLabel(repositoryCount)}: show the Repositories section`
        : `${repositoriesInFolderLabel(repositoryCount)}: show the actions for this folder`}
      onActivate={(event) => showRepositories(event.currentTarget)}
    />
    <button
      type="button"
      class="inline-flex w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring aria-expanded:bg-(--solus-surface-hover) aria-expanded:text-(--solus-text-primary)"
      aria-label="Actions for this folder"
      title="Actions for this folder"
      aria-haspopup="menu"
      aria-expanded={folderMenuOpen}
      data-folder-menu-trigger
      onclick={(event) => toggleFolderMenu(event.currentTarget)}
    >
      <MoreIcon size={PANEL_ROW_ICON_SIZE} aria-hidden="true" />
    </button>
  </div>
  {#if initError}
    <p class="m-0 text-pretty px-2 pb-1 text-chrome-dense leading-snug text-(--solus-status-error)">{initError}</p>
  {/if}
  <DropdownMenu.Root bind:open={folderMenuOpen}>
    <DropdownMenu.Content
      customAnchor={folderMenuAnchor}
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      onInteractOutside={(event) => {
        // The triggers toggle the menu themselves; do not close and reopen here.
        if ((event.target as Element | null)?.closest?.("[data-folder-menu-trigger]") || folderMenuAnchor?.contains(event.target as Node | null)) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        requestInputFocus({ tabId: sourceId });
      }}
    >
      <DropdownMenu.Item disabled={initializing || !canWriteGit} onSelect={() => void initializeGit()}>
        <GitBranchIcon />
        <span class="min-w-0 flex-1 truncate">Track with Git</span>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else if showInit}
  <div class="flex flex-col gap-2 px-1 py-1">
    <p class="text-pretty text-chrome-dense leading-relaxed text-muted-foreground">
      This folder isn't a Git repository yet.
    </p>
    {#if initError}
      <p class="text-pretty text-chrome-dense leading-relaxed text-(--solus-status-error)">{initError}</p>
    {/if}
    <Button
      variant="outline"
      size="sm"
      class="w-full justify-center gap-1.5 text-chrome-dense"
      disabled={initializing || !canWriteGit}
      onclick={initializeGit}
    >
      <GitBranchIcon size={13} />
      {initializing ? "Initializing…" : "Initialize Git"}
    </Button>
  </div>
{/if}

