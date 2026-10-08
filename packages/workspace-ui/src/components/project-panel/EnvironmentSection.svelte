<script lang="ts">
  import {
    Eraser as EraserIcon,
    Folder as FolderIcon,
    Globe as GlobeIcon,
    Smartphone as SmartphoneIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import {
    getSessionEnvironmentStore,
    getPullRequestsContext,
    getWorkspaceContext,
    serversStore,
    toolsStore,
  } from "../../contexts";
  import { browserStore } from "../../contexts/browser/browser.store.svelte";
  import { devicesStore } from "../../contexts/devices/devices.store.svelte";
  import { openDeviceBuilds } from "../devices/lib/device-view-state.svelte";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { projectDirLabel } from "../../lib/paths";
  import { toasts } from "../../lib/toasts";
  import TerminalAppLogo from "../settings/TerminalAppLogo.svelte";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import MenuRow, { type ActionRowItem } from "./MenuRow.svelte";
  import UsageMeters from "./UsageMeters.svelte";
  import {
    clearedBrowserDataLabel,
    clearBrowserDataLabel,
    confirmClearBrowserDataLabel,
    isClearBrowserArmed,
    browserProfileProject,
  } from "./lib/browser-row";
  import { isChat } from "@solus/contracts/chat";
  import { worktreeProjectRoot } from "@solus/contracts/types";
  import { browserPartition } from "@solus/contracts/browser-types";
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
  const detailCwd = $derived(env.cwd);
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
  // The project row names the machine the work runs on, local included: a run
  // with no recorded host runs on the host this tab talks to.
  const runHostLabel = $derived(
    (host ?? serversStore.hostFor(detailServerId))?.label,
  );

  $effect(() => {
    if (!active || !detailCwd) return;
    return environmentStore.watchDetails(detailServerId, detailCwd);
  });

  // The Devices row is for projects that build a mobile app (at the root or
  // in a subfolder), or a conversation already showing a device. It counts
  // the host's app builds, so a build is one click away.
  const deviceProject = $derived(active && projectRoot ? devicesStore.project(detailServerId, projectRoot) : undefined);
  const sessionShowsDevice = $derived(devicesStore.previewsFor(detailServerId, session.sessionFor(sourceId)?.id).length > 0);
  const showsDevices = $derived(!!deviceProject?.isMobileApp || sessionShowsDevice);
  const buildCount = $derived(devicesStore.state(detailServerId)?.builds.length ?? 0);
  $effect(() => {
    if (active && showsDevices && !devicesStore.state(detailServerId) && !devicesStore.unavailable.get(detailServerId)) void devicesStore.load(detailServerId);
  });

  // Clearing the browser profile arms in place, the way "Discard changes…"
  // does in the Git section: the row itself becomes the confirmation, so an
  // action that signs the user out everywhere still costs a second, deliberate
  // click, and the caret beside it is the way back out.
  let clearBrowserArmedFor = $state<string | null>(null);
  const confirmingClearBrowser = $derived(
    isClearBrowserArmed(clearBrowserArmedFor, projectRoot),
  );
  const browserProject = $derived(browserProfileProject(projectRoot));

  const actionRows = $derived.by<(ActionRowItem & { run: () => void })[]>(
    () => [
      {
        key: "terminal",
        label: "Terminal",
        // The row trails with the terminal that will actually open: the one
        // already attached to the shared tmux session, or the Settings fallback
        // when none is. `TerminalAppLogo` keeps it current.
        badge: toolsStore.resolvedTerminal?.name,
        icon: TerminalAppLogo,
        hint: comboHint("orb.open-terminal"),
        phase: "idle",
        disabled: !!hostAffinity,
        tooltip: hostAffinity
          ? `Runs on ${host?.label} — not available for remote sessions`
          : undefined,
        run: () => {
          actions.openTerminal();
          requestInputFocus();
        },
      },
      // The third way into this environment, beside its files and its shell:
      // look at what it serves. The caret carries the profile's reverse state,
      // because the login those pages share outlives every page.
      {
        key: "browser",
        label: confirmingClearBrowser
          ? confirmClearBrowserDataLabel(browserProject)
          : "Browser",
        icon: confirmingClearBrowser ? EraserIcon : GlobeIcon,
        danger: confirmingClearBrowser,
        phase: "idle",
        run: () => {
          if (confirmingClearBrowser) void clearBrowserData();
          else {
            session.openBrowser();
            requestInputFocus();
          }
        },
      },
      // Simulators, connected phones, and the app builds agents made. With a
      // build to install, the row opens straight on Builds.
      ...(showsDevices ? [{
        key: "devices",
        label: "Devices",
        icon: SmartphoneIcon,
        badge: buildCount > 0 ? `${buildCount} build${buildCount === 1 ? "" : "s"}` : undefined,
        phase: "idle" as const,
        run: () => {
          if (buildCount > 0) openDeviceBuilds(session, detailServerId);
          else session.openDevices(undefined, detailServerId);
          requestInputFocus();
        },
      }] : []),
    ],
  );

  async function clearBrowserData() {
    clearBrowserArmedFor = null;
    const project = browserProject;
    try {
      await browserStore.clearProfile(
        detailServerId,
        browserPartition(projectRoot ?? undefined),
      );
      toasts.success(clearedBrowserDataLabel(project));
    } catch (error) {
      toasts.error("Couldn't clear the browser data", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    requestInputFocus();
  }
</script>

<div class="env">
  <!-- The project anchors the card and opens its files; the branch and its
       changes live in the Git card below. -->
  {#if projectRoot && !isChat(projectRoot)}
    <MenuRow
      item={{
        key: "project",
        label: projectDirLabel(projectRoot),
        icon: FolderIcon,
        badge: runHostLabel,
        hint: comboHint("global.toggle-files"),
        phase: "idle",
        disabled: !onOpenFiles,
        tooltip: runHostLabel ? `Runs on ${runHostLabel}` : undefined,
      }}
      onActivate={() => onOpenFiles?.()}
    >
      {#snippet iconSnippet()}
        <ProjectFavicon {projectRoot} serverId={detailServerId} class="size-4" />
      {/snippet}
    </MenuRow>
  {/if}
  <div class="menu-list">
    {#each actionRows as row (row.key)}
      {#if row.key === "browser"}
        <!-- Split row: the label opens the browser, the caret holds the
             profile's reverse state. Two clicks apart, because opening a page
             is routine and forgetting a login is not. The caret is inert with
             no project, where there is nothing to name and nothing to clear. -->
        <div class="split-row">
          <MenuRow item={row} split onActivate={row.run} />
          <button
            type="button"
            class="split-caret"
            class:is-cancel={confirmingClearBrowser}
            disabled={!browserProject}
            aria-label={confirmingClearBrowser
              ? "Keep the browser data"
              : clearBrowserDataLabel(browserProject)}
            title={confirmingClearBrowser
              ? "Keep the browser data"
              : `${clearBrowserDataLabel(browserProject)} — signs out of every site you signed into while browsing, in every worktree of this project`}
            onclick={() =>
              (clearBrowserArmedFor = confirmingClearBrowser
                ? null
                : projectRoot)}
          >
            {#if confirmingClearBrowser}<XIcon size={11} />{:else}<EraserIcon
                size={11}
              />{/if}
          </button>
        </div>
      {:else}
        <MenuRow item={row} onActivate={row.run} />
      {/if}
    {/each}
  </div>
  <!-- Subscription quota closes the section: what's left to spend in this
       environment, per provider. -->
  <UsageMeters {active} />
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

  /* Split row: primary action + a trailing button for its secondary one. The
     two read as one unit (tight gap), each carrying the menu-row hover
     language. Mirrors the Git section's split rows; worth promoting to a shared
     row component the next time either side changes. */
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
  /* Destructive on hover only: at rest this row means "open the browser", and a
     standing red glyph would misreport what the row is for. */
  .split-caret:hover {
    background: var(--solus-status-error-bg);
    color: var(--solus-status-error);
  }
  /* Once armed the caret is the way out, not the destructive half — the row
     beside it carries the danger tone, and two red controls would leave no
     visible difference between confirming and cancelling. */
  .split-caret.is-cancel:hover {
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
