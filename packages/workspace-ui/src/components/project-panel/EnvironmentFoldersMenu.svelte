<script lang="ts">
  /** The menu of the project row of the Environment card. It has one section
   *  for each folder of the session: the working folder, each session folder,
   *  and the folders of the codebase on other hosts. A section has the places
   *  that show its folder and the options of that folder. A session with one
   *  folder has the menu of a session with one project: no heading. */
  import {
    FolderPlus as AddFolderIcon,
    GitBranch as GitIcon,
    Laptop as LaptopIcon,
    Link as AttachIcon,
    SquareTerminal as TerminalIcon,
    Unlink as DetachIcon,
  } from "@lucide/svelte";
  import type { SvelteSet } from "svelte/reactivity";
  import type { SessionFolder } from "@solus/contracts/codebases";
  import type { FileManagerKind } from "@solus/contracts/types";
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
  import { fileManagerNameFor } from "../../lib/file-manager";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { hasSessionStarted } from "../../lib/sessionUtils";
  import { toasts } from "../../lib/toasts";
  import AgentAvatar from "../conversation/AgentAvatar.svelte";
  import { openAgentSession } from "../conversation/agent-conversation/lib/agent-conversation";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import solusIcon from "../../../../../resources/icon.iconset/icon_32x32@2x.png";
  import FileManagerIcon from "./FileManagerIcon.svelte";
  import type { ActionRowIcon } from "./MenuRow.svelte";
  import { useEnvironmentFolderReads } from "./lib/environment-folder-reads.svelte";
  import {
    childRepositoryNote,
    environmentMenu,
    otherHostFolders,
    type ChildSessionRow,
    type EnvironmentFolderAction,
    type EnvironmentMenuSection,
  } from "./lib/environment-folders";
  import { codebaseMembersOn } from "./lib/git-repositories";
  import { treeAgentRows } from "./lib/rail-agents";
  import { addSessionFolder, errorText } from "./lib/repository-actions";

  interface Props {
    /** The tab or draft whose run the menu describes: see `ProjectPanel`. */
    sourceId: string;
    /** Hidden mounted tabs and a closed project panel must not read the host. */
    active: boolean;
    open: boolean;
    /** The caret that opens the menu. The menu opens below its row. */
    anchor: HTMLElement | null;
    /** The host of the run. */
    serverId: string;
    host: { label: string | undefined; isLocal: boolean };
    /** The project folder of the run, and its name on the row of a run with no codebase. */
    projectRoot: string;
    projectName: string;
    /** The file manager of the host, when this client can open it. */
    fileManager: FileManagerKind | undefined;
    /** Opens the files pane at the working folder. */
    onOpenFiles?: () => void;
    /** The folder commands that run now: the project row shows that it works. */
    busy: SvelteSet<string>;
  }
  let { sourceId, active, open = $bindable(), anchor, serverId, host, projectRoot, projectName, fileManager, onOpenFiles, busy }: Props = $props();

  const session = getWorkspaceContext();
  const environmentStore = getSessionEnvironmentStore();
  const pullRequests = getPullRequestsContext();

  const run = $derived(session.runFor(sourceId));
  const api = $derived(session.apiFor(sourceId));
  const env = $derived(environmentStore.environmentFor(run));
  // The folders of a session exist on its host once it has started.
  const sessionId = $derived.by(() => {
    const panelSession = session.sessionFor(sourceId);
    return panelSession && hasSessionStarted(panelSession) ? panelSession.id : null;
  });
  const folders = $derived(sessionId ? (session.sessionFor(sourceId)?.sessionFolders ?? []) : []);
  const codebaseId = $derived(codebaseOf(run));
  const codebase = $derived(codebaseId ? codebasesStore.codebaseOf(codebaseId) : undefined);
  const hostGroups = $derived(codebaseId ? codebasesStore.membersOf(codebaseId) : []);

  // The folders of the codebase on the hosts this session does not run on.
  const otherGroups = $derived(sessionId ? hostGroups.filter((group) => group.serverId !== serverId) : []);
  const treeView = $derived(active && sessionId && otherGroups.length > 0 ? sessionTreeStore.viewFor(sessionId, serverId) : null);
  const otherHosts = $derived(
    sessionId
      ? otherHostFolders(
          otherGroups,
          serverId,
          treeAgentRows(treeView?.tree ?? null, sessionId, serverId),
          (hostId) => knownRunnerFor(hostId, serversStore.knownHosts) ?? serverConnections.resolveId(hostId),
          (otherServerId) => hostPolicy.isClientMachine(otherServerId),
        )
      : [],
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
  const canChange = $derived(!!sessionId && canDriveSession(serverId, sessionId));
  const me = $derived(hosts.get(serverId)?.me);
  const mayReadFiles = $derived(me?.may("host.files.read") ?? true);

  const menu = $derived(
    environmentMenu({
      working: { path: env.cwd, name: projectName, state: env.repoRoot ? "git" : env.status === null ? "plain" : null },
      folders,
      draftMembers: sessionId ? [] : codebaseMembersOn(hostGroups, serverId),
      otherHosts,
      host,
      codebaseName: codebase?.name ?? null,
      isInCodebase: (path) => !!codebaseId && codebasesStore.codebasesOfFolder(serverId, path).some((each) => each.id === codebaseId),
      fileManagerName: fileManager ? fileManagerNameFor(fileManager) : null,
      // A terminal opens on the screen of the host: only the desktop app has one, for its own machine.
      canOpenTerminal: !!hosts.device?.hasDesktopHandlers && hostPolicy.isClientMachine(serverId),
      canAddFolder: canChange,
    }),
  );

  const OPTION_ICON = {
    "open-terminal": TerminalIcon,
    attach: AttachIcon,
    detach: DetachIcon,
    "add-to-codebase": AddFolderIcon,
    "track-with-git": GitIcon,
  } satisfies Record<Exclude<EnvironmentFolderAction, "open-in-solus" | "open-in-file-manager">, ActionRowIcon>;

  function isActionAllowed(section: EnvironmentMenuSection, action: EnvironmentFolderAction): boolean {
    if (action === "open-in-solus") return mayReadFiles && (section.place !== "working" || !!onOpenFiles);
    if (action === "open-in-file-manager") return true;
    if (action === "open-terminal") return me?.may("host.terminal") ?? false;
    return action === "track-with-git" ? (me?.may("host.git.write") ?? true) : canChange;
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
  function applyFolders(ofSessionId: string, next: SessionFolder[]) {
    const current = session.sessionFor(sourceId);
    if (current?.id === ofSessionId) current.sessionFolders = next;
  }

  function openInSolus(section: EnvironmentMenuSection) {
    if (section.place === "working") onOpenFiles?.();
    else {
      session.openFiles(sourceId, section.path);
      requestInputFocus({ tabId: sourceId });
    }
  }

  async function openInFileManager(section: EnvironmentMenuSection) {
    // The working folder of a worktree session opens at its project folder, as the row names it.
    const opened = await api.openInFileManager(section.place === "working" ? projectRoot : section.path).catch(() => false);
    if (!opened && fileManager) toasts.error(`Couldn’t open this folder in ${fileManagerNameFor(fileManager)}`);
  }

  function runAction(section: EnvironmentMenuSection, action: EnvironmentFolderAction) {
    const key = `${action}:${section.key}`;
    if (action === "open-in-solus") {
      openInSolus(section);
    } else if (action === "open-in-file-manager") {
      void openInFileManager(section);
    } else if (action === "open-terminal") {
      // The terminal opens at the folder of the section, on the host of the session.
      gitActionsFor(sourceId, session, environmentStore, pullRequests.projects, { path: section.path, repositoryPath: section.repositoryPath }).openTerminal();
    } else if (action === "track-with-git") {
      void act(key, "Couldn't track the folder with Git", async () => {
        const isTracked = await repositorySetupStore.initialize(api, serverId, section.path);
        if (!isTracked) throw new Error(repositorySetupStore.initErrorFor(serverId, section.path) ?? "Git did not start in this folder.");
      });
    } else if (action === "add-to-codebase") {
      const target = codebase;
      if (!target) return;
      void act(key, "Couldn't add the folder to the codebase", async () => {
        await codebasesStore.addRoot(target.id, { serverId, path: section.repositoryPath });
        toasts.success(`Added ${section.heading.name} to ${target.name}`);
      });
    } else if (sessionId) {
      const ofSessionId = sessionId;
      if (action === "attach") void act(key, "Couldn't attach the folder", async () => applyFolders(ofSessionId, await api.sessionAttachFolder(ofSessionId, section.path)));
      else void act(key, "Couldn't detach the folder", async () => applyFolders(ofSessionId, await api.sessionDetachFolder(ofSessionId, section.path)));
    }
  }

  async function openChild(section: EnvironmentMenuSection, child: ChildSessionRow) {
    if (!section.serverId) return;
    try {
      await openAgentSession(
        { sessionId: child.id, cwd: child.cwd },
        child.provider,
        section.serverId,
        {
          resume: (resumed, opts) => session.opening.resumeSession(resumed, opts),
          openInSplit: (openedTabId) => session.openTabAsSurface(openedTabId),
        },
      );
    } catch (error) {
      toasts.error("Could not open the session", { description: String(error) });
      requestInputFocus({ tabId: sourceId });
    }
  }
</script>

{#snippet sectionItems(section: EnvironmentMenuSection)}
  {#each section.items as item (item.key)}
    {#if item.kind === "session"}
      {@const child = item.session}
      {@const note = section.serverId ? childRepositoryNote(environmentStore.statusFor(section.serverId, child.cwd)) : null}
      <DropdownMenu.Item disabled={!section.serverId} aria-label="Open {item.label}, {child.status}" onSelect={() => void openChild(section, child)}>
        <AgentAvatar provider={child.provider} variant="row" />
        <span class="min-w-0 flex-1 truncate">{item.label}</span>
        <span class="max-w-1/2 shrink-0 truncate text-chrome-dense text-(--solus-text-tertiary)">{note ?? child.status}</span>
      </DropdownMenu.Item>
    {:else}
      <DropdownMenu.Item disabled={!isActionAllowed(section, item.action)} onSelect={() => runAction(section, item.action)}>
        {#if item.action === "open-in-solus"}
          <img src={solusIcon} alt="" class="size-4 shrink-0" />
        {:else if item.action === "open-in-file-manager"}
          {#if fileManager}<FileManagerIcon kind={fileManager} />{/if}
        {:else}
          {@const OptionIcon = OPTION_ICON[item.action]}
          <OptionIcon />
        {/if}
        <span class="min-w-0 flex-1 truncate">{item.label}</span>
        {#if item.action === "open-in-solus" && section.place === "working"}
          <DropdownMenu.Shortcut>{comboHint("global.toggle-files")}</DropdownMenu.Shortcut>
        {/if}
      </DropdownMenu.Item>
    {/if}
  {/each}
  {#if section.emptyNote}
    <DropdownMenu.Item disabled>{section.emptyNote}</DropdownMenu.Item>
  {/if}
{/snippet}

<DropdownMenu.Root bind:open>
  <DropdownMenu.Content
    customAnchor={anchor?.parentElement ?? anchor}
    side="bottom"
    align="start"
    sideOffset={4}
    alignOffset={0}
    collisionPadding={8}
    onInteractOutside={(event) => {
      // The caret is the menu's trigger — let its click toggle the menu rather
      // than closing here and immediately reopening.
      if (anchor?.contains(event.target as Node | null)) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      // No bits-ui trigger to return to; the prompt is the next natural stop.
      event.preventDefault();
      requestInputFocus();
    }}
    class={menu.showsHeadings ? "w-[min(17rem,calc(100vw-2rem))]" : "w-[min(14rem,calc(100vw-2rem))]"}
  >
    {#each menu.sections as section, index (section.key)}
      {#if index > 0}
        <DropdownMenu.Separator />
      {/if}
      {#if menu.showsHeadings}
        {@const heading = section.heading}
        <DropdownMenu.Group>
          <!-- A folder name keeps its letters as they are: the caps of a menu heading would change it. -->
          <DropdownMenu.GroupHeading class="flex min-w-0 items-center gap-1.5 leading-4 font-normal tracking-normal normal-case" title={section.tooltip}>
            <span class="min-w-0 flex-1 truncate font-medium text-(--solus-text-secondary)">{heading.name}</span>
            {#if heading.isLocalHost}
              <LaptopIcon size={12} class="shrink-0" aria-hidden="true" />
              <span class="sr-only">on this machine</span>
            {:else if heading.hostLabel}
              <span class="min-w-0 max-w-28 shrink truncate">{heading.hostLabel}</span>
            {/if}
            {#if heading.state}
              <span class="shrink-0">{!heading.isLocalHost && heading.hostLabel ? "· " : ""}{heading.state}</span>
            {/if}
          </DropdownMenu.GroupHeading>
          {@render sectionItems(section)}
        </DropdownMenu.Group>
      {:else}
        {@render sectionItems(section)}
      {/if}
    {/each}
    {#if menu.addFolderLabel}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={() => addSessionFolder(session, sourceId)}>
        <AddFolderIcon />
        <span class="min-w-0 flex-1 truncate">{menu.addFolderLabel}</span>
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
