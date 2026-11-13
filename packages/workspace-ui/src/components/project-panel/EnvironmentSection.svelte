<script lang="ts">
  import {
    Boxes as ArtifactIcon,
    Check as CheckIcon,
    ChevronDown as CaretDownIcon,
    Folder as FolderIcon,
    Globe as GlobeIcon,
    Laptop as LaptopIcon,
    Smartphone as SmartphoneIcon,
  } from "@lucide/svelte";
  import {
    getSessionEnvironmentStore,
    getPullRequestsContext,
    getWorkspaceContext,
    serversStore,
    groupKeyFor,
    hosts,
  } from "../../contexts";
  import { devicesStore } from "../../contexts/devices/devices.store.svelte";
  import { openRunApp } from "../devices/lib/device-view-state.svelte";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { fileManagerNameFor } from "../../lib/file-manager";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { projectDirLabel } from "../../lib/paths";
  import { toasts } from "../../lib/toasts";
  import OpenInRow from "./OpenInRow.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import MenuRow, { type ActionRowIcon } from "./MenuRow.svelte";
  import FileManagerIcon from "./FileManagerIcon.svelte";
  import solusIcon from "../../../../../resources/icon.iconset/icon_32x32@2x.png";
  import UsageMeters from "./UsageMeters.svelte";
  import { NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { checkoutPlace, runHost } from "../../contexts/workspace/run-location";
  import {
    ENVIRONMENT_VIEWS,
    ENVIRONMENT_VIEW_LABELS,
    environmentViewFor,
    type EnvironmentView,
  } from "@solus/client-core/environment-view";
  import { environmentViewChoices } from "./lib/environment-view";
  import { sessionArtifactsStore } from "../../contexts/sessions/session-artifacts.store.svelte";
  import { isPanelItemShown } from "./lib/panel-items";

  interface Props {
    /** The tab or draft whose run this section describes — see `ProjectPanel`. */
    sourceId: string;
    active?: boolean;
    onOpenFiles?: () => void;
    /** The person's hidden panel items. A hidden row unmounts, and its reads stop. */
    hiddenItems: readonly string[];
  }
  let { sourceId, active = true, onOpenFiles, hiddenItems }: Props = $props();

  const projectShown = $derived(isPanelItemShown(hiddenItems, "environment.project"));
  const terminalShown = $derived(isPanelItemShown(hiddenItems, "environment.terminal"));
  const viewShown = $derived(isPanelItemShown(hiddenItems, "environment.view"));
  const usageShown = $derived(isPanelItemShown(hiddenItems, "environment.usage"));

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const sectionRun = $derived(session.runFor(sourceId));
  const env = $derived(environmentStore.environmentFor(sectionRun));
  const detailServerId = $derived(
    serverConnections.serverIdForApi(session.apiFor(sourceId)),
  );
  const actions = $derived(gitActionsFor(sourceId, session, environmentStore, pullRequests.projects));
  const projectRoot = $derived(
    env.checkout?.repoRoot ??
      checkoutPlace(sectionRun)?.path ??
      env.status?.repoRoot ??
      worktreeProjectRoot(env.cwd),
  );

  // The host this session was dispatched to, or a draft will dispatch to. It
  // governs which actions can run — local is the unmarked case, so the
  // affinity glyph is null for it.
  const host = $derived(serversStore.hostFor(runHost(sectionRun)));
  const hostAffinity = $derived(serversStore.affinityFor(runHost(sectionRun)));
  /** What this client may do on the host: a guest opens no terminal, browser, or device here (permissions.md). */
  const me = $derived(hosts.get(detailServerId)?.me);
  // The project row marks the machine the work runs on: a laptop glyph for
  // this machine, the name for a remote one. A run with no recorded host runs
  // on the host this tab talks to.
  const runServer = $derived(host ?? serversStore.hostFor(detailServerId));
  const runHostLabel = $derived(runServer?.label);

  // The project row's caret opens a menu of the places that can show the
  // folder: the files pane here, and the host's file manager. The file manager opens on
  // the host's own screen, so only a local connection is offered it.
  const fileManager = $derived(
    me?.may("host.local.window") ? hosts.get(detailServerId)?.capabilityRecord?.fileManager : undefined,
  );
  const mayReadFiles = $derived(me?.may("host.files.read") ?? true);
  let openInMenuOpen = $state(false);
  let openInAnchor = $state<HTMLElement | null>(null);

  async function openInFileManager() {
    if (!projectRoot) return;
    const opened = await session.apiFor(sourceId).openInFileManager(projectRoot).catch(() => false);
    if (!opened && fileManager) toasts.error(`Couldn’t open this folder in ${fileManagerNameFor(fileManager)}`);
  }

  // Builds are for projects that build a mobile app (at the root or in a
  // subfolder), or a conversation already showing a device.
  const deviceProject = $derived(active && viewShown && projectRoot ? devicesStore.project(detailServerId, projectRoot) : undefined);
  const sessionId = $derived(session.sessionFor(sourceId)?.id);
  const sessionShowsDevice = $derived(devicesStore.previewsFor(detailServerId, sessionId).length > 0);
  const showsDevices = $derived(!!deviceProject?.isMobileApp || sessionShowsDevice);
  $effect(() => {
    if (active && viewShown && showsDevices && !devicesStore.state(detailServerId) && !devicesStore.unavailable.get(detailServerId)) void devicesStore.load(detailServerId);
  });

  // The view row: the browser, the builds, or this session's Artifacts
  // surface, which also lists what its delegation tree made. The list is read
  // once; changes arrive as events.
  const artifactCount = $derived(sessionArtifactsStore.countFor(sessionId));
  $effect(() => {
    if (active && viewShown && sessionId) sessionArtifactsStore.ensure(detailServerId, sessionId);
  });
  // A draft has no session yet; its choice is kept under the draft.
  const choiceKey = $derived(sessionId ?? sourceId);
  const viewFacts = $derived({
    chosen: environmentViewChoices.chosenFor(detailServerId, choiceKey),
    sessionShowsDevice,
    artifactCount,
    // A draft has no session, so it has no artifacts to wait for. A failed
    // read counts as answered; the Artifacts surface shows the failure.
    artifactsKnown: !sessionId || sessionArtifactsStore.isLoaded(sessionId) || sessionArtifactsStore.hasFailed(sessionId),
  });
  // Null until the session's artifacts answer: the row waits rather than
  // naming Browser and then changing to Artifacts.
  const view = $derived(environmentViewFor(viewFacts));
  /** A guest opens no browser or device on the host, as the rows before this one. */
  const mayUseHost = $derived(me?.may("host.use") ?? true);
  const VIEW_ICON = { browser: GlobeIcon, builds: SmartphoneIcon, artifacts: ArtifactIcon } satisfies Record<EnvironmentView, ActionRowIcon>;
  let viewMenuOpen = $state(false);
  let viewMenuAnchor = $state<HTMLElement | null>(null);

  function openView(target: EnvironmentView) {
    if (target === "browser") session.openBrowser();
    else if (target === "builds") openRunApp(session, detailServerId, sessionId);
    // A draft has no session, so it has no Artifacts surface yet.
    else if (sessionId) session.openArtifacts(sessionId);
    requestInputFocus();
  }

  function chooseView(target: EnvironmentView) {
    environmentViewChoices.choose(detailServerId, choiceKey, target);
    openView(target);
  }

</script>

<div class="env">
  <!-- The project anchors the card and opens its files; the branch and its
       changes live in the Git card below. A chat has no project, but the row
       stays: it is the one place the panel names the host the chat runs on. -->
  {#if projectShown && projectRoot}
    <!-- Split row in the Git rows' language: the row opens the folder in
         Solus, the caret offers the other places that can show it. -->
    {@const hasNoFolder = projectRoot === NEW_CHAT_DIRECTORY || !mayReadFiles}
    <div class="split-row">
      <MenuRow
        split
        item={{
          key: "project",
          label: projectDirLabel(projectRoot),
          icon: FolderIcon,
          badge: runServer?.local ? undefined : runHostLabel,
          badgeIcon: runServer?.local ? LaptopIcon : undefined,
          hint: comboHint("global.toggle-files"),
          phase: "idle",
          // A new chat has no folder until its first prompt, so no files yet.
          disabled: hasNoFolder || !onOpenFiles,
          tooltip: runHostLabel ? `Runs on ${runHostLabel}` : undefined,
        }}
        onActivate={() => onOpenFiles?.()}
      >
        {#snippet iconSnippet()}
          <ProjectFavicon projectKey={groupKeyFor(detailServerId, projectRoot)} class="size-4" />
        {/snippet}
      </MenuRow>
      <button
        type="button"
        class="split-caret"
        class:is-open={openInMenuOpen}
        aria-label="Open in"
        title="Open in"
        aria-haspopup="menu"
        aria-expanded={openInMenuOpen}
        disabled={hasNoFolder || (!onOpenFiles && !fileManager)}
        onclick={(event) => {
          if (openInMenuOpen) {
            openInMenuOpen = false;
            return;
          }
          openInAnchor = event.currentTarget;
          openInMenuOpen = true;
        }}
      >
        <CaretDownIcon size={11} />
      </button>
    </div>
  {/if}
  <div class="menu-list">
    {#if terminalShown}
      <OpenInRow {sourceId} {active} openTerminal={() => actions.openTerminal()} />
    {/if}
    <!-- One row for what the environment shows. The row opens this session's
         view; the caret lets the user choose another, kept for the session. -->
    {#if viewShown}
    <div class="split-row">
      <MenuRow
        split
        item={{
          key: "view",
          label: view ? ENVIRONMENT_VIEW_LABELS[view] : "Checking session…",
          icon: VIEW_ICON[view ?? "browser"],
          badge: view === "artifacts" && artifactCount > 1 ? String(artifactCount) : undefined,
          phase: view ? "idle" : "loading",
          disabled: !view || !mayUseHost,
        }}
        onActivate={() => {
          if (view) openView(view);
        }}
      />
      <button
        type="button"
        class="split-caret"
        class:is-open={viewMenuOpen}
        aria-label="Choose what to show"
        title="Choose what to show"
        aria-haspopup="menu"
        aria-expanded={viewMenuOpen}
        disabled={!mayUseHost}
        onclick={(event) => {
          if (viewMenuOpen) {
            viewMenuOpen = false;
            return;
          }
          viewMenuAnchor = event.currentTarget;
          viewMenuOpen = true;
        }}
      >
        <CaretDownIcon size={11} />
      </button>
    </div>
    {/if}
  </div>
  <DropdownMenu.Root bind:open={viewMenuOpen}>
    <DropdownMenu.Content
      customAnchor={viewMenuAnchor?.parentElement ?? viewMenuAnchor}
      side="bottom"
      align="start"
      sideOffset={4}
      alignOffset={0}
      collisionPadding={8}
      onInteractOutside={(event) => {
        if (viewMenuAnchor?.contains(event.target as Node | null)) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        requestInputFocus();
      }}
      class="w-[min(17rem,calc(100vw-2rem))]"
    >
      {#each ENVIRONMENT_VIEWS as option (option)}
        {@const OptionIcon = VIEW_ICON[option]}
        <DropdownMenu.Item aria-checked={option === view} role="menuitemradio" onSelect={() => chooseView(option)}>
          <OptionIcon />
          <span class="min-w-0 flex-1 truncate">{ENVIRONMENT_VIEW_LABELS[option]}</span>
          {#if option === "artifacts" && artifactCount > 1}
            <DropdownMenu.Shortcut class="tabular-nums">{artifactCount}</DropdownMenu.Shortcut>
          {:else if option === view}
            <CheckIcon class="size-4 shrink-0" />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
  <DropdownMenu.Root bind:open={openInMenuOpen}>
    <DropdownMenu.Content
      customAnchor={openInAnchor?.parentElement ?? openInAnchor}
      side="bottom"
      align="start"
      sideOffset={4}
      alignOffset={0}
      collisionPadding={8}
      onInteractOutside={(event) => {
        // The caret is the menu's trigger — let its click toggle the menu rather
        // than closing here and immediately reopening.
        if (openInAnchor?.contains(event.target as Node | null)) event.preventDefault();
      }}
      onCloseAutoFocus={(event) => {
        // No bits-ui trigger to return to; the prompt is the next natural stop.
        event.preventDefault();
        requestInputFocus();
      }}
      class="w-[min(14rem,calc(100vw-2rem))]"
    >
      <DropdownMenu.Item disabled={!onOpenFiles} onSelect={() => onOpenFiles?.()}>
        <img src={solusIcon} alt="" class="size-4 shrink-0" />
        <span class="min-w-0 flex-1 truncate">Open in Solus</span>
        <DropdownMenu.Shortcut>{comboHint("global.toggle-files")}</DropdownMenu.Shortcut>
      </DropdownMenu.Item>
      {#if fileManager}
        <DropdownMenu.Item onSelect={() => void openInFileManager()}>
          <FileManagerIcon kind={fileManager} />
          <span class="min-w-0 flex-1 truncate">Open in {fileManagerNameFor(fileManager)}</span>
        </DropdownMenu.Item>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
  <!-- Subscription quota closes the section: what's left to spend in this
       environment, per provider. -->
  {#if usageShown}
    <UsageMeters serverId={detailServerId} {active} />
  {/if}
</div>

<style>
  .env {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    margin-bottom: 0.5rem;
  }

  .menu-list {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }
  /* Split-button, as in GitSection: the row and its caret read as one unit. */
  .split-row {
    display: flex;
    align-items: stretch;
    gap: 0.0625rem;
  }
  .split-caret {
    flex-shrink: 0;
    width: 1.625rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .split-caret:hover,
  .split-caret.is-open {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .split-caret:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .split-caret:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .split-caret:disabled:hover {
    background: transparent;
    color: var(--solus-text-tertiary);
  }
</style>
