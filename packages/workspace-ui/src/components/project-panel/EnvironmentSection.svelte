<script lang="ts">
  import {
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
    toolsStore,
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
  import TerminalAppLogo from "../settings/TerminalAppLogo.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import MenuRow, { type ActionRowItem } from "./MenuRow.svelte";
  import FileManagerIcon from "./FileManagerIcon.svelte";
  import solusIcon from "../../../../../resources/icon.iconset/icon_32x32@2x.png";
  import UsageMeters from "./UsageMeters.svelte";
  import { NEW_CHAT_DIRECTORY } from "@solus/contracts/chat";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import { serverConnections } from "@solus/client-core/server-connections";

  interface Props {
    /** The tab or draft whose run this section describes — see `ProjectPanel`. */
    sourceId: string;
    active?: boolean;
    onOpenFiles?: () => void;
  }
  let { sourceId, active = true, onOpenFiles }: Props = $props();

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
      sectionRun?.workingDirectory ??
      env.status?.repoRoot ??
      worktreeProjectRoot(env.cwd),
  );

  // The host this session was dispatched to, or a draft will dispatch to. It
  // governs which actions can run — local is the unmarked case, so the
  // affinity glyph is null for it.
  const host = $derived(serversStore.hostFor(sectionRun?.serverId));
  const hostAffinity = $derived(serversStore.affinityFor(sectionRun?.serverId));
  /** What this client may do on the host: a guest opens no terminal, browser, or device here (permissions.md). */
  const me = $derived(hosts.get(detailServerId)?.me);
  // The project row marks the machine the work runs on: a laptop glyph for
  // this machine, the name for a remote one. A run with no recorded host runs
  // on the host this tab talks to.
  const runHost = $derived(host ?? serversStore.hostFor(detailServerId));
  const runHostLabel = $derived(runHost?.label);

  // The project row opens a menu of the places that can show the folder: the
  // files pane here, and the host's file manager. The file manager opens on
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

  // The Devices row is for projects that build a mobile app (at the root or
  // in a subfolder), or a conversation already showing a device. It counts
  // Run app, before a simulator or phone is opened.
  const deviceProject = $derived(active && projectRoot ? devicesStore.project(detailServerId, projectRoot) : undefined);
  const sessionShowsDevice = $derived(devicesStore.previewsFor(detailServerId, session.sessionFor(sourceId)?.id).length > 0);
  const showsDevices = $derived(!!deviceProject?.isMobileApp || sessionShowsDevice);
  $effect(() => {
    if (active && showsDevices && !devicesStore.state(detailServerId) && !devicesStore.unavailable.get(detailServerId)) void devicesStore.load(detailServerId);
  });

  const actionRows = $derived.by<(ActionRowItem & { run: () => void })[]>(
    () => [
      {
        key: "terminal",
        label: "Terminal",
        // Show the configured terminal icon until inspection or use resolves
        // the terminal already attached to the shared session.
        badge: toolsStore.resolvedTerminal?.name,
        icon: TerminalAppLogo,
        hint: comboHint("orb.open-terminal"),
        phase: "idle",
        disabled: !!hostAffinity || !(me?.may("host.terminal") ?? true),
        tooltip: hostAffinity
          ? `Runs on ${host?.label} — not available for remote sessions`
          : undefined,
        run: () => {
          actions.openTerminal();
          requestInputFocus();
        },
      },
      // The third way into this environment, beside its files and its shell:
      // look at what it serves. Its login is cleared from the browser pane.
      {
        key: "browser",
        label: "Browser",
        icon: GlobeIcon,
        phase: "idle",
        disabled: !(me?.may("host.use") ?? true),
        run: () => {
          session.openBrowser();
          requestInputFocus();
        },
      },
      // App execution starts with the project and chosen device.
      ...(showsDevices ? [{
        key: "devices",
        label: "Run app",
        icon: SmartphoneIcon,
        phase: "idle" as const,
        disabled: !(me?.may("host.use") ?? true),
        run: () => {
          openRunApp(session, detailServerId, session.sessionFor(sourceId)?.id);
          requestInputFocus();
        },
      }] : []),
    ],
  );
</script>

<div class="env">
  <!-- The project anchors the card and opens its files; the branch and its
       changes live in the Git card below. A chat has no project, but the row
       stays: it is the one place the panel names the host the chat runs on. -->
  {#if projectRoot}
    <MenuRow
      item={{
        key: "project",
        label: projectDirLabel(projectRoot),
        icon: FolderIcon,
        badge: runHost?.local ? undefined : runHostLabel,
        badgeIcon: runHost?.local ? LaptopIcon : undefined,
        phase: "idle",
        // A new chat has no folder until its first prompt, so no files yet.
        disabled: projectRoot === NEW_CHAT_DIRECTORY || !mayReadFiles || (!onOpenFiles && !fileManager),
        tooltip: runHostLabel ? `Runs on ${runHostLabel}` : undefined,
        disclosure: "open-in",
      }}
      menuOpen={openInMenuOpen}
      onActivate={(event) => {
        if (openInMenuOpen) {
          openInMenuOpen = false;
          return;
        }
        openInAnchor = event.currentTarget;
        openInMenuOpen = true;
      }}
    >
      {#snippet iconSnippet()}
        <ProjectFavicon projectKey={groupKeyFor(detailServerId, projectRoot)} class="size-4" />
      {/snippet}
    </MenuRow>
  {/if}
  <div class="menu-list">
    {#each actionRows as row (row.key)}
        <MenuRow
          item={row}
          onInspect={() => {
            if (active && row.key === "terminal") void toolsStore.refreshResolvedTerminal(session.settings.fallbackTerminal);
          }}
          onActivate={row.run}
        />
    {/each}
  </div>
  <DropdownMenu.Root bind:open={openInMenuOpen}>
    <DropdownMenu.Content
      customAnchor={openInAnchor}
      side="left"
      align="start"
      sideOffset={10}
      alignOffset={-6}
      collisionPadding={8}
      onInteractOutside={(event) => {
        // The row is the menu's trigger — let its click toggle the menu rather
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
  <UsageMeters serverId={detailServerId} {active} />
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
</style>
