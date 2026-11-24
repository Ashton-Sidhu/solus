<script lang="ts">
  import {
    Ellipsis as MoreIcon,
    Folder as FolderIcon,
    FolderGit2 as RepositoryIcon,
    FolderOpen as OpenFilesIcon,
    FolderPlus as AddFolderIcon,
    GitBranch as GitIcon,
    GitFork as WorktreeIcon,
    Link as AttachIcon,
    Unlink as DetachIcon,
    Plus as PlusIcon,
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
  import { codebaseOf, isDispatch, projectRoot } from "../../contexts/workspace/run-location";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import GitSection from "./GitSection.svelte";
  import GitSetupSection from "./GitSetupSection.svelte";
  import MenuRow, { PANEL_ROW_ICON_SIZE, type ActionRowIcon } from "./MenuRow.svelte";
  import OtherHostFolders from "./OtherHostFolders.svelte";
  import { isPanelItemShown } from "./lib/panel-items";
  import { treeAgentRows } from "./lib/rail-agents";
  import {
    candidateRows,
    otherHostFolders,
    repositoryActionLabel,
    repositoryRowExpanded,
    repositoryRowReading,
    repositoryRows,
    type RepositoryRow,
    type RepositoryRowAction,
  } from "./lib/repositories-section";
  import { addSessionFolder, errorText } from "./lib/repository-actions";
  import { useRepositoryReads } from "./lib/repository-reads.svelte";

  interface Props {
    /** The tab whose session this section describes — see `ProjectPanel`. */
    sourceId: string;
    /** The Solus id of that session. */
    sessionId: string;
    /** Hidden mounted tabs and a closed project panel must not read the host. */
    active: boolean;
    /** The person's hidden panel items. A hidden row unmounts. */
    hiddenItems: readonly string[];
    /** Open the changes of one repository of the session in the diff panel. */
    onOpenChanges: (repositoryPath: string | null) => void;
  }
  let { sourceId, sessionId, active, hiddenItems, onOpenChanges }: Props = $props();

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
  // A folder of a task folder with no repository holds links to the files of its original.
  const inTaskFolder = $derived(isTaskFolderPath(env.cwd));
  // The project of the working directory on the run host. A dispatch has its project home on a different host.
  const workingProject = $derived(isDispatch(run) ? (env.repoRoot ?? env.cwd) : projectRoot(run));

  const foldersShown = $derived(isPanelItemShown(hiddenItems, "repositories.folders"));
  // A terminal opens on the screen of the host: only the desktop app has one, for its own machine.
  const canOpenTerminal = $derived(!!hosts.device?.hasDesktopHandlers && hostPolicy.isClientMachine(serverId));
  const rows = $derived(
    repositoryRows({
      working: {
        path: env.cwd,
        repositoryPath: env.repoRoot,
        projectPath: workingProject,
        isLinkedPlainFolder: inTaskFolder && !env.repoRoot,
      },
      folders,
      hasCodebase: !!codebase,
      isInCodebase: (path) => !!codebaseId && codebasesStore.codebasesOfFolder(serverId, path).some((each) => each.id === codebaseId),
      canOpenTerminal,
    }),
  );

  // The folders of the codebase on the hosts this session does not run on.
  const otherGroups = $derived(
    codebaseId && isPanelItemShown(hiddenItems, "repositories.otherHosts")
      ? codebasesStore.membersOf(codebaseId).filter((group) => group.serverId !== serverId)
      : [],
  );
  const treeView = $derived(active && otherGroups.length > 0 ? sessionTreeStore.viewFor(sessionId, serverId) : null);
  const otherHosts = $derived(
    otherHostFolders(
      otherGroups,
      serverId,
      treeAgentRows(treeView?.tree ?? null, sessionId, serverId),
      (hostId) => knownRunnerFor(hostId, serversStore.knownHosts) ?? serverConnections.resolveId(hostId),
    ),
  );

  useRepositoryReads({
    get active() { return active; },
    get serverId() { return serverId; },
    get gitPathsKey() { return foldersShown ? rows.filter((row) => row.state === "git").map((row) => row.path).join("\n") : ""; },
    get codebaseId() { return codebaseId; },
    get treeSessionId() { return otherGroups.length > 0 ? sessionId : null; },
    environment: environmentStore,
    codebases: codebasesStore,
    sessionTree: sessionTreeStore,
  });

  // A guest reads and changes nothing: the folders of a session are its driver's to change.
  const canChange = $derived(canDriveSession(serverId, sessionId));
  const me = $derived(hosts.get(serverId)?.me);
  const canWriteGit = $derived(me?.may("host.git.write") ?? true);

  const ROW_ICON = { working: RepositoryIcon, isolated: WorktreeIcon, git: RepositoryIcon, plain: FolderIcon } satisfies Record<string, ActionRowIcon>;
  function iconOf(row: RepositoryRow): ActionRowIcon {
    if (row.state === "plain") return ROW_ICON.plain;
    return row.isIsolated ? ROW_ICON.isolated : ROW_ICON.git;
  }

  // The Git actions of one session folder show below its row. One folder at a time.
  let expandedKey = $state<string | null>(null);
  const busy = new SvelteSet<string>();

  function activate(row: RepositoryRow, trigger: HTMLButtonElement) {
    if (row.kind === "working") {
      onOpenChanges(null);
      return;
    }
    // A folder with no repository has no Git actions: its row opens its menu.
    if (row.state !== "git") {
      if (row.actions.length > 0) toggleRowMenu(row, trigger);
      return;
    }
    expandedKey = expandedKey === row.key ? null : row.key;
    requestInputFocus({ tabId: sourceId });
  }

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
    if (current) current.sessionFolders = next;
  }

  const ACTION_ICON = {
    "open-files": OpenFilesIcon,
    "open-terminal": TerminalIcon,
    attach: AttachIcon,
    detach: DetachIcon,
    "add-to-codebase": AddFolderIcon,
    "track-with-git": GitIcon,
  } satisfies Record<RepositoryRowAction, ActionRowIcon>;

  function isActionAllowed(action: RepositoryRowAction): boolean {
    if (action === "open-files") return me?.may("host.files.read") ?? true;
    if (action === "open-terminal") return me?.may("host.terminal") ?? false;
    return action === "track-with-git" ? canWriteGit : canChange;
  }

  /** The files pane and the terminal open at the folder of the row, on the host of the session. */
  function openRowFolder(row: RepositoryRow, action: "open-files" | "open-terminal") {
    if (action === "open-files") {
      session.openFiles(sourceId, row.path);
      requestInputFocus({ tabId: sourceId });
      return;
    }
    const folder = row.kind === "working" ? null : { path: row.path, repositoryPath: row.repositoryPath };
    gitActionsFor(sourceId, session, environmentStore, pullRequests.projects, folder).openTerminal();
  }

  function runAction(row: RepositoryRow, action: RepositoryRowAction) {
    rowMenuOpen = false;
    const key = `${action}:${row.key}`;
    if (action === "open-files" || action === "open-terminal") {
      openRowFolder(row, action);
    } else if (action === "attach") {
      void act(key, "Couldn't attach the folder", async () => applyFolders(await api.sessionAttachFolder(sessionId, row.path)));
    } else if (action === "detach") {
      void act(key, "Couldn't detach the folder", async () => {
        applyFolders(await api.sessionDetachFolder(sessionId, row.path));
        if (expandedKey === row.key) expandedKey = null;
      });
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

  // A row's menu opens below that row, as the Git rows' menus do.
  let rowMenuOpen = $state(false);
  let menuRow = $state<RepositoryRow | null>(null);
  let menuAnchor = $state<HTMLElement | null>(null);

  function toggleRowMenu(row: RepositoryRow, trigger: HTMLButtonElement) {
    if (rowMenuOpen && menuRow?.key === row.key) {
      rowMenuOpen = false;
      return;
    }
    menuRow = row;
    menuAnchor = trigger.parentElement;
    rowMenuOpen = true;
  }

  // "Add repository" in a task folder session: the repositories of the
  // codebase that have no worktree in the task folder. Read when the menu opens.
  let candidatesOpen = $state(false);
  let candidatesAnchor = $state<HTMLElement | null>(null);
  let candidates = $state<{ state: "loading" | "ready" | "error"; rows: { path: string; name: string }[]; error: string | null }>({ state: "loading", rows: [], error: null });
  let candidatesRead = 0;

  async function openCandidates(trigger: HTMLElement) {
    if (candidatesOpen) {
      candidatesOpen = false;
      return;
    }
    candidatesAnchor = trigger;
    candidates = { state: "loading", rows: [], error: null };
    candidatesOpen = true;
    const read = ++candidatesRead;
    try {
      const answer = await api.sessionWorktreeCandidates(sessionId);
      if (read === candidatesRead) candidates = { state: "ready", rows: candidateRows(answer), error: null };
    } catch (error) {
      if (read === candidatesRead) candidates = { state: "error", rows: [], error: errorText(error) };
    }
  }

  function addRepository(repositoryPath: string) {
    candidatesOpen = false;
    // The host refuses a repository that cannot get a worktree here, with the reason.
    void act(`add-repository:${repositoryPath}`, "Couldn't add the repository", async () =>
      applyFolders(await api.sessionAddRepositoryWorktree(sessionId, repositoryPath)),
    );
  }
</script>

<div class="flex flex-col gap-px pb-1.5">
  {#if foldersShown}
    {#each rows as row (row.key)}
      {@const reading = repositoryRowReading(row, environmentStore.statusFor(serverId, row.path))}
      {@const expanded = repositoryRowExpanded(row, expandedKey)}
      {@const isExpanded = expanded === true}
      {@const isBusy = row.actions.some((action) => busy.has(`${action}:${row.key}`))}
      <div class="flex min-w-0 items-stretch gap-px">
        <MenuRow
          item={{
            key: row.key,
            label: row.name,
            icon: iconOf(row),
            phase: isBusy ? "loading" : "idle",
            diffStat: reading.diffStat,
            badge: reading.badge,
            tooltip: reading.tooltip,
          }}
          ariaLabel={row.kind === "working"
            ? `${row.name}, the working directory: open its changes`
            : row.state === "git"
              ? `${row.name}: ${isExpanded ? "hide" : "show"} its Git actions`
              : `${row.name}: show its actions`}
          split={row.actions.length > 0}
          {expanded}
          onActivate={(event) => activate(row, event.currentTarget)}
        />
        {#if row.actions.length > 0}
          <button
            type="button"
            class="inline-flex w-6.5 shrink-0 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-ring aria-expanded:bg-(--solus-surface-hover) aria-expanded:text-(--solus-text-primary)"
            aria-label="Actions for {row.name}"
            title="Actions for {row.name}"
            aria-haspopup="menu"
            aria-expanded={rowMenuOpen && menuRow?.key === row.key}
            data-repository-menu-trigger
            onclick={(event) => toggleRowMenu(row, event.currentTarget)}
          >
            <MoreIcon size={PANEL_ROW_ICON_SIZE} aria-hidden="true" />
          </button>
        {/if}
      </div>
      {#if row.note}
        <p class="m-0 text-pretty px-2 pb-1 pl-8 text-chrome-dense leading-snug text-(--solus-text-tertiary)">{row.note}</p>
      {/if}
      {#if isExpanded}
        <!-- The Git section, aimed at this folder: the same rows, menus, and
             dialogs as for the working directory. -->
        <div class="ml-4 border-l border-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)] pl-1.5">
          <GitSection
            {sourceId}
            {active}
            {hiddenItems}
            folder={{ path: row.path, repositoryPath: row.repositoryPath }}
            onOpenChanges={() => onOpenChanges(row.path)}
          />
          {#if isPanelItemShown(hiddenItems, "git.setup")}
            <GitSetupSection {sourceId} {active} folder={{ path: row.path, repositoryPath: row.repositoryPath }} />
          {/if}
        </div>
      {/if}
    {/each}

    {#if codebaseId && !codebase && codebasesStore.hosts.some((host) => host.serverId === serverId && host.status === "ready")}
      <p class="m-0 text-pretty px-2 py-1 text-chrome-dense leading-snug text-(--solus-text-tertiary)">
        The codebase of this session is not on this host. It was deleted, or this host has not received it.
      </p>
    {/if}

    {#if canChange}
      <MenuRow
        item={{ key: "add-folder", label: "Add folder…", icon: PlusIcon, phase: "idle", tooltip: "Attach a folder on this host to the session" }}
        onActivate={() => addSessionFolder(session, sourceId)}
      />
      {#if inTaskFolder && codebaseId}
        <MenuRow
          item={{ key: "add-repository", label: "Add repository…", icon: WorktreeIcon, phase: "idle", tooltip: "Make a worktree of one more repository of the codebase, on the branch of this session" }}
          onActivate={(event) => void openCandidates(event.currentTarget)}
        />
      {/if}
    {/if}
  {/if}

  {#if otherHosts.length > 0}
    {#if foldersShown}
      <div class="mx-2 mt-1.5 mb-1 h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]" aria-hidden="true"></div>
    {/if}
    <OtherHostFolders tabId={sourceId} hosts={otherHosts} />
  {/if}
</div>

<DropdownMenu.Root bind:open={rowMenuOpen}>
  <DropdownMenu.Content
    customAnchor={menuAnchor}
    side="bottom"
    align="start"
    sideOffset={4}
    collisionPadding={8}
    onInteractOutside={(event) => {
      // The trigger toggles the menu itself; do not close and reopen here.
      if ((event.target as Element | null)?.closest?.("[data-repository-menu-trigger]")) event.preventDefault();
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
        {@const actionLabel = repositoryActionLabel(action, codebase?.name ?? null)}
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

<DropdownMenu.Root bind:open={candidatesOpen}>
  <DropdownMenu.Content
    customAnchor={candidatesAnchor}
    side="bottom"
    align="start"
    sideOffset={4}
    collisionPadding={8}
    class="w-(--bits-dropdown-menu-anchor-width) min-w-48"
    onInteractOutside={(event) => {
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
      <DropdownMenu.Item disabled class="whitespace-normal">Each repository of the codebase that can get a worktree has one.</DropdownMenu.Item>
    {:else}
      {#each candidates.rows as candidate (candidate.path)}
        <DropdownMenu.Item title={candidate.path} onSelect={() => addRepository(candidate.path)}>
          <RepositoryIcon />
          <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
        </DropdownMenu.Item>
      {/each}
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
