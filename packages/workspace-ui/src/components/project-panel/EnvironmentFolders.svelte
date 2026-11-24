<script lang="ts">
  /** The folders of the Environment card, below its project row: each session
   *  folder that is not a repository of the project, with its state and its
   *  menu, then the folders of the codebase on other hosts. The Git card has
   *  the Git state of each repository. A session with one project and no
   *  other folder has no row here. */
  import {
    ChevronDown as CaretDownIcon,
    Folder as FolderIcon,
    FolderGit2 as RepositoryIcon,
    FolderOpen as OpenFilesIcon,
    FolderPlus as AddFolderIcon,
    GitBranch as GitIcon,
    GitFork as WorktreeIcon,
    Laptop as LaptopIcon,
    Link as AttachIcon,
    Unlink as DetachIcon,
    SquareTerminal as TerminalIcon,
  } from "@lucide/svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { isTaskFolderPath, type SessionFolder } from "@solus/contracts/codebases";
  import { hostPolicy } from "@solus/client-core/host-policy";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { knownRunnerFor } from "@solus/client-core/session-runner";
  import {
    codebasesStore,
    getPullRequestsContext,
    getSessionEnvironmentStore,
    getWorkspaceContext,
    hosts,
    serversStore,
  } from "../../contexts";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import { sessionTreeStore } from "../../contexts/sessions/session-tree.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { codebaseOf } from "../../contexts/workspace/run-location";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { PLAIN_MEMBER_LINKS_NOTE } from "../input/lib/worktree-repositories";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import MenuRow, { type ActionRowIcon } from "./MenuRow.svelte";
  import OtherHostFolders from "./OtherHostFolders.svelte";
  import { useEnvironmentFolderReads } from "./lib/environment-folder-reads.svelte";
  import {
    environmentFolderActionLabel,
    environmentFolderRows,
    environmentFolderTrailing,
    otherHostFolders,
    type EnvironmentFolderAction,
    type EnvironmentFolderRow,
  } from "./lib/environment-folders";
  import { treeAgentRows } from "./lib/rail-agents";
  import { errorText } from "./lib/repository-actions";

  interface Props {
    /** The tab whose session this card describes: see `ProjectPanel`. */
    sourceId: string;
    /** The Solus id of that session. */
    sessionId: string;
    /** Hidden mounted tabs and a closed project panel must not read the host. */
    active: boolean;
  }
  let { sourceId, sessionId, active }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const pullRequests = getPullRequestsContext();

  const run = $derived(session.runFor(sourceId));
  const serverId = $derived(session.serverIdFor(sourceId));
  const api = $derived(session.apiFor(sourceId));
  const env = $derived(environmentStore.environmentFor(run));
  const folders = $derived(session.sessionFor(sourceId)?.sessionFolders ?? []);
  const codebaseId = $derived(codebaseOf(run));
  const codebase = $derived(codebaseId ? codebasesStore.codebaseOf(codebaseId) : undefined);
  const runServer = $derived(serversStore.hostFor(serverId));

  // A terminal opens on the screen of the host: only the desktop app has one, for its own machine.
  const canOpenTerminal = $derived(!!hosts.device?.hasDesktopHandlers && hostPolicy.isClientMachine(serverId));
  const rows = $derived(
    environmentFolderRows({
      workingPath: env.cwd,
      folders,
      hasCodebase: !!codebase,
      isInCodebase: (path) => !!codebaseId && codebasesStore.codebasesOfFolder(serverId, path).some((each) => each.id === codebaseId),
      canOpenTerminal,
    }),
  );

  // The folders of the codebase on the hosts this session does not run on.
  const otherGroups = $derived(codebaseId ? codebasesStore.membersOf(codebaseId).filter((group) => group.serverId !== serverId) : []);
  const treeView = $derived(active && otherGroups.length > 0 ? sessionTreeStore.viewFor(sessionId, serverId) : null);
  const otherHosts = $derived(
    otherHostFolders(
      otherGroups,
      serverId,
      treeAgentRows(treeView?.tree ?? null, sessionId, serverId),
      (hostId) => knownRunnerFor(hostId, serversStore.knownHosts) ?? serverConnections.resolveId(hostId),
    ),
  );

  useEnvironmentFolderReads({
    get active() { return active; },
    get serverId() { return serverId; },
    get codebaseId() { return codebaseId; },
    get treeSessionId() { return otherGroups.length > 0 ? sessionId : null; },
    codebases: codebasesStore,
    sessionTree: sessionTreeStore,
  });

  // A guest reads and changes nothing: the folders of a session are its driver's to change.
  const canChange = $derived(canDriveSession(serverId, sessionId));
  const me = $derived(hosts.get(serverId)?.me);
  const mayReadFiles = $derived(me?.may("host.files.read") ?? true);

  const ROW_ICON = { isolated: WorktreeIcon, git: RepositoryIcon, plain: FolderIcon } satisfies Record<string, ActionRowIcon>;
  function iconOf(row: EnvironmentFolderRow): ActionRowIcon {
    if (row.state === "plain") return ROW_ICON.plain;
    return row.isIsolated ? ROW_ICON.isolated : ROW_ICON.git;
  }

  const ACTION_ICON = {
    "open-files": OpenFilesIcon,
    "open-terminal": TerminalIcon,
    attach: AttachIcon,
    detach: DetachIcon,
    "add-to-codebase": AddFolderIcon,
    "track-with-git": GitIcon,
  } satisfies Record<EnvironmentFolderAction, ActionRowIcon>;

  function isActionAllowed(action: EnvironmentFolderAction): boolean {
    if (action === "open-files") return mayReadFiles;
    if (action === "open-terminal") return me?.may("host.terminal") ?? false;
    return action === "track-with-git" ? (me?.may("host.git.write") ?? true) : canChange;
  }

  const busy = new SvelteSet<string>();

  /** One command at a time for each key. A failure is said to the person; focus goes back to the prompt. */
  async function act(key: string, failure: string, work: () => Promise<void>) {
    if (busy.has(key)) return;
    busy.add(key);
    try {
      await work();
    } catch (error) {
      toasts.error(failure, { description: errorText(error) });
    } finally {
      busy.delete(key);
      requestInputFocus({ tabId: sourceId });
    }
  }

  /** The host's answer is the list now; its `session_folders` event says the same. One property changes. */
  function applyFolders(next: SessionFolder[]) {
    const current = session.sessionFor(sourceId);
    if (current?.id === sessionId) current.sessionFolders = next;
  }

  function openFiles(row: EnvironmentFolderRow) {
    session.openFiles(sourceId, row.path);
    requestInputFocus({ tabId: sourceId });
  }

  function runAction(row: EnvironmentFolderRow, action: EnvironmentFolderAction) {
    menuOpen = false;
    const key = `${action}:${row.key}`;
    if (action === "open-files") {
      openFiles(row);
    } else if (action === "open-terminal") {
      // The terminal opens at the folder of the row, on the host of the session.
      gitActionsFor(sourceId, session, environmentStore, pullRequests.projects, { path: row.path, repositoryPath: row.repositoryPath }).openTerminal();
    } else if (action === "attach") {
      void act(key, "Couldn't attach the folder", async () => applyFolders(await api.sessionAttachFolder(sessionId, row.path)));
    } else if (action === "detach") {
      void act(key, "Couldn't detach the folder", async () => applyFolders(await api.sessionDetachFolder(sessionId, row.path)));
    } else if (action === "add-to-codebase") {
      const target = codebase;
      if (!target) return;
      void act(key, "Couldn't add the folder to the codebase", async () => {
        await codebasesStore.addRoot(target.id, { serverId, path: row.repositoryPath });
        toasts.success(`Added ${row.name} to ${target.name}`);
      });
    } else {
      void act(key, "Couldn't track the folder with Git", async () => {
        const isTracked = await repositorySetupStore.initialize(api, serverId, row.path);
        if (!isTracked) throw new Error(repositorySetupStore.initErrorFor(serverId, row.path) ?? "Git did not start in this folder.");
      });
    }
  }

  // The menu of a row opens below that row, as the menu of the project row does.
  let menuOpen = $state(false);
  let menuRow = $state<EnvironmentFolderRow | null>(null);
  let menuAnchor = $state<HTMLElement | null>(null);

  function toggleMenu(row: EnvironmentFolderRow, trigger: HTMLButtonElement) {
    if (menuOpen && menuRow?.key === row.key) {
      menuOpen = false;
      return;
    }
    menuRow = row;
    menuAnchor = trigger.parentElement;
    menuOpen = true;
  }
</script>

<!-- A folder of a task folder with no repository holds links to the files of its original. -->
{#if isTaskFolderPath(env.cwd) && !env.repoRoot}
  <p class="m-0 text-pretty px-2 pb-1 pl-8 text-chrome-dense leading-snug text-(--solus-text-tertiary)">{PLAIN_MEMBER_LINKS_NOTE}</p>
{/if}

{#if rows.length > 0}
  <div class="flex flex-col gap-px" role="group" aria-label="Folders of this session">
    {#each rows as row (row.key)}
      {@const trailing = environmentFolderTrailing(row, { label: runServer?.label, isLocal: !!runServer?.local })}
      {@const isBusy = row.actions.some((action) => busy.has(`${action}:${row.key}`))}
      {@const isMenuOpen = menuOpen && menuRow?.key === row.key}
      <div class="flex min-w-0 items-stretch gap-px">
        <MenuRow
          split
          item={{
            key: row.key,
            label: row.name,
            icon: iconOf(row),
            phase: isBusy ? "loading" : "idle",
            badge: trailing.badge,
            badgePrefix: trailing.badgePrefix,
            badgeIcon: runServer?.local ? LaptopIcon : undefined,
            disabled: !mayReadFiles,
            tooltip: row.tooltip,
          }}
          ariaLabel="{row.name}{row.mark ? `, ${row.mark}` : ''}: open its files"
          onActivate={() => openFiles(row)}
        />
        <button
          type="button"
          class="inline-flex w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none aria-expanded:bg-(--solus-surface-hover) aria-expanded:text-(--solus-text-primary)"
          aria-label="Actions for {row.name}"
          title="Actions for {row.name}"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          data-folder-menu-trigger
          onclick={(event) => toggleMenu(row, event.currentTarget)}
        >
          <CaretDownIcon size={11} aria-hidden="true" />
        </button>
      </div>
    {/each}
  </div>
{/if}

{#if codebaseId && !codebase && codebasesStore.hosts.some((host) => host.serverId === serverId && host.status === "ready")}
  <p class="m-0 text-pretty px-2 py-1 text-chrome-dense leading-snug text-(--solus-text-tertiary)">
    The codebase of this session is not on this host. It was deleted, or this host has not received it.
  </p>
{/if}

{#if otherHosts.length > 0}
  <OtherHostFolders tabId={sourceId} hosts={otherHosts} />
{/if}

<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={menuAnchor}
    side="bottom"
    align="start"
    sideOffset={4}
    collisionPadding={8}
    class="w-[min(14rem,calc(100vw-2rem))]"
    onInteractOutside={(event) => {
      // The caret toggles the menu itself; do not close and reopen here.
      if ((event.target as Element | null)?.closest?.("[data-folder-menu-trigger]")) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      event.preventDefault();
      requestInputFocus({ tabId: sourceId });
    }}
  >
    {#if menuRow}
      {@const row = menuRow}
      {#each row.actions as action (action)}
        {@const ActionIcon = ACTION_ICON[action]}
        {@const actionLabel = environmentFolderActionLabel(action, codebase?.name ?? null)}
        {#if actionLabel}
          <DropdownMenu.Item disabled={!isActionAllowed(action)} onSelect={() => runAction(row, action)}>
            <ActionIcon />
            <span class="min-w-0 flex-1 truncate">{actionLabel}</span>
          </DropdownMenu.Item>
        {/if}
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
