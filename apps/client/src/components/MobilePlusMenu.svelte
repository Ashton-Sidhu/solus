<script lang="ts">
  import Icon from "@iconify/svelte";
  import {
    HERO_CARD,
    HERO_LABEL,
    LIST_ICON,
    LIST_LABEL,
    LIST_ROW,
    LIST_VALUE,
    META_LINE,
    ROW_CHEVRON,
    ROW_DIVIDER,
    SEGMENT_GROUP,
    SEGMENT_OFF,
    SEGMENT_ON,
  } from "./lib/plus-menu-styles";
  import { SHEET_CARD, SHEET_SECTION_LABEL } from "./lib/sheet-styles";
  import {
    Paperclip as PaperclipIcon,
    LibraryBig as BooksIcon,
    GitCompareArrows as GitDiffIcon,
    Settings as GearIcon,
    FolderOpen as FolderOpenIcon,
    ArrowDownToLine as GitPullIcon,
    GitCommitHorizontal as GitCommitIcon,
    GitPullRequest as GitPullRequestIcon,
    SquareArrowUp as ArrowSquareUpIcon,
    RotateCcw as ArrowCounterClockwiseIcon,
    Check as CheckIcon,
    Loader as SpinnerIcon,
    Info as InfoIcon,
    ChevronRight as CaretRightIcon,
    Database as HardDrivesIcon,
    Monitor as MonitorIcon,
  } from "@lucide/svelte";
  import {
    getWorkspaceContext,
    getStatusBarContext,
    getSessionEnvironmentStore,
    getPullRequestsContext,
    hostCapabilitiesStore,
    serversStore,
  } from "@solus/workspace-ui/contexts";
  import { gitActionsFor } from "@solus/workspace-ui/lib/git-actions.svelte";
  import {
    gitPublishModel,
    isPullRequestRunning,
  } from "@solus/workspace-ui/components/project-panel/lib/git-action-selection";
  import { repositorySetupStore } from "@solus/workspace-ui/contexts/git/repository-setup.store.svelte";
  import PublishRepositoryDialog from "@solus/workspace-ui/components/project-panel/publish-repository/PublishRepositoryDialog.svelte";
  import MobileSheet from "./MobileSheet.svelte";
  import { LOCAL_SERVER_ID } from "@solus/client-core/server-registry";
  import { serverConnections } from "@solus/client-core/server-connections";
  import { localApi } from "@solus/client-core/local-api";

  interface Props {
    open: boolean;
    onClose: () => void;
    /** The composer that opened this sheet — a started session's tab, or the id
     *  of the draft composing one. Every row reads and writes through it, so a
     *  draft's project, host and git actions are the ones this sheet edits
     *  rather than whatever tab happens to be active behind it. */
    sourceId?: string;
    onAttachFile: (sourceId?: string) => void;
    onToggleWorkspace: () => void;
    onToggleDiff: () => void;
    canShowDiffPanel: boolean;
    diffPanelOpen: boolean;
    changedFilesCount: number;
    onOpenServers: () => void;
  }
  let {
    open,
    onClose,
    sourceId,
    onAttachFile,
    onToggleWorkspace,
    onToggleDiff,
    canShowDiffPanel,
    diffPanelOpen,
    changedFilesCount,
    onOpenServers,
  }: Props = $props();

  const session = getWorkspaceContext();
  const statusBar = getStatusBarContext();

  const composerSourceId = $derived(sourceId ?? session.activeTabId);
  const composerRun = $derived(session.runFor(composerSourceId));

  // Attach opens on what you came for; Actions holds what happens to the
  // repository. Kept across reopens on purpose — the tab you were last in is
  // almost always the one you want next. What the run *is* — agent, model,
  // effort, mode — is not here: it lives behind the model button, which is the
  // control that already names it.
  type SheetTab = "attach" | "actions";
  let tab = $state<SheetTab>("attach");
  const TABS: { id: SheetTab; label: string }[] = [
    { id: "attach", label: "Attach" },
    { id: "actions", label: "Actions" },
  ];

  const attachmentServerId = $derived(
    composerRun?.serverId ??
      serverConnections.defaultServerId() ??
      LOCAL_SERVER_ID,
  );
  const attachmentCapabilities = $derived(
    hostCapabilitiesStore.for(attachmentServerId),
  );
  const canAttachFiles = $derived(
    attachmentCapabilities?.attachUpload === true,
  );
  const attachmentHostLabel = $derived(
    serversStore.hostFor(attachmentServerId)?.label ??
      serverConnections.connectionFor(attachmentServerId)?.target.label ??
      "this host",
  );

  $effect(() => {
    void hostCapabilitiesStore.load(attachmentServerId);
  });

  const ctx = $derived(statusBar.ctxForRun(composerRun));

  const workingDirectory = $derived(ctx.workingDirectory);
  const gitDisabled = $derived(!workingDirectory || workingDirectory === "~");

  const projectName = $derived.by(() => {
    const wd = workingDirectory;
    if (!wd || wd === "~") return "None";
    const parts = wd.replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || wd;
  });

  // The shared GitActions store routes every call through the session's own
  // host (`apiFor`), so these rows work for dispatched sessions too. It is
  // memoized per source id and shared with the desktop project panel, so the
  // PRs store is not optional: without it, the moment a pull request is created
  // the hand-off that lets the sidebar and task row name it throws, and the
  // success toast never fires.
  const environmentStore = getSessionEnvironmentStore();
  const pullRequests = getPullRequestsContext();
  const actions = $derived(
    gitActionsFor(composerSourceId, session, environmentStore, pullRequests.projects),
  );
  const gitEnvironment = $derived(
    environmentStore.environmentFor(composerRun),
  );
  const gitApi = $derived(session.apiFor(composerSourceId));
  const gitServerId = $derived(serverConnections.serverIdForApi(gitApi));
  // The same readiness model the project panel renders: an unpublished project
  // publishes from this row rather than offering a push into nowhere.
  const gitModel = $derived(
    gitPublishModel(gitEnvironment.status, {
      repository: repositorySetupStore.statusFor(gitServerId, gitEnvironment.cwd),
      githubConnected: repositorySetupStore.githubConnectedFor(gitServerId, gitEnvironment.cwd),
    }),
  );
  const gitPrimaryAction = $derived(gitModel.pullRequest.primary);
  const pushStep = $derived(gitModel.commit.steps.find((step) => step.key === "push"));
  const isCommitActionRunning = $derived(
    actions.running &&
      (actions.activeAction === "commit" ||
        actions.activeAction === "commit_push" ||
        actions.activeAction === "commit_push_pull_request"),
  );
  const isPullRequestActionRunning = $derived(
    actions.running && isPullRequestRunning(actions.activeAction, actions.activePhase),
  );

  $effect(() => {
    if (!open || !gitEnvironment.cwd || gitEnvironment.cwd === "~") return;
    return environmentStore.watchDetails(gitEnvironment.cwd);
  });

  // The readiness stage decides what these rows mean, so the sheet reads the
  // repository probe — and, only on the publish path, the GitHub connection.
  $effect(() => {
    if (!open || !gitApi || !gitEnvironment.cwd || gitEnvironment.cwd === "~") return;
    void repositorySetupStore.refresh(gitApi, gitServerId, gitEnvironment.cwd);
    if (gitModel.readiness !== "local-only") return;
    void repositorySetupStore.refreshGithubConnection(
      gitApi,
      gitServerId,
      session.ctxForEnvironment(gitEnvironment.cwd, gitEnvironment.checkout, composerSourceId),
      gitEnvironment.cwd,
    );
  });

  let publishDialogOpen = $state(false);

  function runPrimaryGitAction() {
    if (gitPrimaryAction.kind === "view") {
      localApi.openExternal(gitPrimaryAction.url);
      return;
    }
    if (gitPrimaryAction.kind === "publish" || gitPrimaryAction.kind === "connect") {
      publishDialogOpen = true;
      return;
    }
    if (gitPrimaryAction.kind !== "run") return;
    void actions.run(gitPrimaryAction.action, {
      createFeatureBranch: gitPrimaryAction.createFeatureBranch,
    });
  }

  // Discard arms in place — the row itself becomes the confirmation, which
  // beats a modal on touch. Re-armed closed every time the sheet opens.
  let confirmingDiscard = $state(false);
  $effect(() => {
    if (open) confirmingDiscard = false;
  });

  async function handleDiscard() {
    if (gitDisabled || actions.discarding) return;
    confirmingDiscard = false;
    await actions.discard();
  }

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  /**
   * Ask for a project on behalf of *this* composer. `requesterId` takes a tab id
   * or a draft id, which is the whole reason it exists — dispatched bare, the
   * pick reached the handler with no source, and a draft (the only composer a
   * phone has before Send) got a second draft opened at that project instead of
   * being pointed at it.
   */
  function openProjectPicker() {
    handleAction(() =>
      window.dispatchEvent(
        new CustomEvent("solus:open-directory-picker", {
          detail: { requesterId: composerSourceId },
        }),
      ),
    );
  }

  const browserOpen = $derived(session.router.at("browser"));

</script>

<MobileSheet {open} {onClose} title="Add to chat">
  <!-- One surface declaration for all three tabs (ADR-0013): rows, buttons and
       segment labels inherit it, and only the qualifying lines step down. -->
  <div class="flex flex-col text-sm">
  <div class="px-4 pb-3.5">
    <div class={SEGMENT_GROUP} role="tablist" aria-label="Add to chat">
      {#each TABS as entry (entry.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          class={tab === entry.id ? SEGMENT_ON : SEGMENT_OFF}
          onclick={() => (tab = entry.id)}
        >
          {entry.label}
        </button>
      {/each}
    </div>
  </div>

  {#if tab === "attach"}
    <div class="flex flex-col gap-5 px-4 pb-1">
      <div class="flex gap-2.5">
        <button
          class="{HERO_CARD} disabled:cursor-not-allowed"
          onclick={() => handleAction(() => onAttachFile(composerSourceId))}
          disabled={!canAttachFiles}
          title={!canAttachFiles ? `File attachments are not supported on ${attachmentHostLabel}.` : undefined}
        >
          <PaperclipIcon size={20} class="text-(--primary)" />
          <span class={HERO_LABEL}>{canAttachFiles ? "Files" : "Unavailable"}</span>
        </button>
        <button
          class={HERO_CARD}
          onclick={openProjectPicker}
        >
          <FolderOpenIcon size={20} class="text-(--primary)" />
          <span class={HERO_LABEL}>Project</span>
        </button>
        <button class={HERO_CARD} onclick={() => handleAction(onToggleWorkspace)}>
          <BooksIcon size={20} class="text-(--primary)" />
          <span class={HERO_LABEL}>Workspace</span>
        </button>
      </div>

      {#if attachmentCapabilities !== undefined && !canAttachFiles}
        <p class="-mt-2 px-0.5 {META_LINE}">
          File attachments are not supported on {attachmentHostLabel}.
        </p>
      {/if}

      <!-- The two live artefacts of this session: what the agent is looking at,
           and what it has written. Both open rather than attach, so neither
           pretends to be a file you picked. -->
      <div class="flex flex-col gap-2">
        <span class={SHEET_SECTION_LABEL}>From this session</span>
        <div class={SHEET_CARD}>
          <button
            class={LIST_ROW}
            onclick={() => handleAction(() => {
              if (browserOpen) session.router.close("browser");
              else session.openBrowser();
            })}
          >
            <span class={LIST_ICON}><MonitorIcon size={16} /></span>
            <span class={LIST_LABEL}>Browser</span>
            {#if browserOpen}<span class={LIST_VALUE}>Open</span>{/if}
            <CaretRightIcon size={15} class={ROW_CHEVRON} />
          </button>
          <div class={ROW_DIVIDER}></div>
          <button class={LIST_ROW} disabled={!canShowDiffPanel} onclick={() => handleAction(onToggleDiff)}>
            <span class={LIST_ICON}><GitDiffIcon size={16} /></span>
            <span class={LIST_LABEL}>Uncommitted changes</span>
            {#if !canShowDiffPanel}
              <!-- A draft has no session to diff, and a review surface is
                   addressed by a tab. Say so rather than reading as "no
                   changes", which is a different fact. -->
              <span class={LIST_VALUE}>Unavailable</span>
            {:else if diffPanelOpen}
              <span class={LIST_VALUE}>Open</span>
            {:else if changedFilesCount > 0}
              <span class="shrink-0 font-mono {META_LINE}">
                {changedFilesCount} file{changedFilesCount === 1 ? "" : "s"}
              </span>
            {:else}
              <span class={LIST_VALUE}>None</span>
            {/if}
            <CaretRightIcon size={15} class={ROW_CHEVRON} />
          </button>
        </div>
        <p class="px-0.5 {META_LINE}">
          Attachments stay in the composer until you send.
        </p>
      </div>
    </div>
  {:else}
    <div class="flex flex-col gap-4 px-4 pb-1">
      {#if gitDisabled}
        <!-- The reason once, at the group, with the two moves that resolve it —
             rather than five rows that each look broken on their own. -->
        <div class="rounded-2xl bg-(--SHEET_CARD) p-3.5 shadow-[shadow:var(--elev-ring)]">
          <div class="flex gap-2.5">
            <InfoIcon size={16} class="mt-px shrink-0 text-(--muted-foreground)" />
            <div>
              <div class="font-semibold tracking-[-0.01em] text-(--solus-text-primary)">
                Git actions need a repository
              </div>
              <p class="mt-1 {META_LINE} text-pretty">
                <span class="font-mono">{projectName}</span>
                {projectName === "None"
                  ? "is not a project yet, so Sync, Commit and Pull requests have nothing to act on."
                  : "is a plain folder, so Sync, Commit and Pull requests have nothing to act on."}
              </p>
            </div>
          </div>
          <div class="mt-3 flex gap-2">
            <button
              type="button"
              class="h-[2.125rem] cursor-pointer rounded-lg border-0 bg-transparent px-3.5 font-medium text-(--solus-text-primary) shadow-[shadow:var(--elev-ring)] [-webkit-tap-highlight-color:transparent]"
              onclick={openProjectPicker}
            >
              Choose a project
            </button>
            <button
              type="button"
              class="h-[2.125rem] cursor-pointer rounded-lg border-0 bg-transparent px-3.5 font-medium text-(--muted-foreground) [-webkit-tap-highlight-color:transparent]"
              onclick={() => handleAction(onOpenServers)}
            >
              Switch host
            </button>
          </div>
        </div>
      {:else}
        <div class={SHEET_CARD}>
          <button
            class={LIST_ROW}
            onclick={() => void actions.sync()}
            disabled={actions.syncing || gitModel.sync.disabled}
            title={gitModel.sync.reason}
          >
            <span class="{LIST_ICON} {actions.synced ? '!text-(--solus-status-complete)' : ''}">
              {#key actions.syncing ? "busy" : actions.synced ? "done" : "idle"}
                <span class="icon-swap">
                  {#if actions.syncing}
                    <SpinnerIcon size={16} class="animate-spin" />
                  {:else if actions.synced}
                    <CheckIcon size={16} />
                  {:else}
                    <GitPullIcon size={16} />
                  {/if}
                </span>
              {/key}
            </span>
            <span class={LIST_LABEL}>{actions.synced ? "Synced" : "Sync"}</span>
          </button>
          <div class={ROW_DIVIDER}></div>
          <button class={LIST_ROW} onclick={() => void actions.run("commit")} disabled={actions.running}>
            <span class="{LIST_ICON} {actions.lastResult?.commit.status === 'created' ? '!text-(--solus-status-complete)' : ''}">
              {#key isCommitActionRunning ? "busy" : actions.lastResult?.commit.status === "created" ? "done" : "idle"}
                <span class="icon-swap">
                  {#if isCommitActionRunning}
                    <SpinnerIcon size={16} class="animate-spin" />
                  {:else if actions.lastResult?.commit.status === "created"}
                    <CheckIcon size={16} />
                  {:else}
                    <GitCommitIcon size={16} />
                  {/if}
                </span>
              {/key}
            </span>
            <span class={LIST_LABEL}>Commit</span>
          </button>
          <div class={ROW_DIVIDER}></div>
          <button
            class={LIST_ROW}
            onclick={() => void actions.run("commit_push")}
            disabled={actions.running || gitModel.readiness !== "published"}
            title={gitModel.readiness === "published" ? undefined : pushStep?.reason}
          >
            <span class={LIST_ICON}><ArrowSquareUpIcon size={16} /></span>
            <span class={LIST_LABEL}>Commit & Push</span>
          </button>
          <div class={ROW_DIVIDER}></div>
          <button
            class={LIST_ROW}
            onclick={() => handleAction(runPrimaryGitAction)}
            disabled={actions.running || gitPrimaryAction.kind === "disabled"}
            title={gitPrimaryAction.kind === "disabled" ? gitPrimaryAction.reason : undefined}
          >
            <span class={LIST_ICON}>
              {#if isPullRequestActionRunning}
                <SpinnerIcon size={16} class="animate-spin" />
              {:else if gitPrimaryAction.kind === "publish" || gitPrimaryAction.kind === "connect"}
                <Icon icon="logos:github-icon" width={16} height={16} />
              {:else}
                <GitPullRequestIcon size={16} />
              {/if}
            </span>
            <span class={LIST_LABEL}>{isPullRequestActionRunning ? (actions.activeLabel ?? gitPrimaryAction.label) : gitPrimaryAction.label}</span>
          </button>
          {#if changedFilesCount > 0}
            <div class={ROW_DIVIDER}></div>
            {#if confirmingDiscard}
              <div class="flex items-center gap-2 px-3.5 py-2.5">
                <span class="min-w-0 flex-1 text-(--solus-text-secondary)">
                  Discards {changedFilesCount} uncommitted change{changedFilesCount === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded-lg bg-[color-mix(in_oklab,var(--solus-status-error)_12%,transparent)] px-3 py-1.5 font-semibold text-(--solus-status-error) [-webkit-tap-highlight-color:transparent]"
                  onclick={handleDiscard}
                >
                  Discard
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded-lg px-3 py-1.5 font-medium text-(--muted-foreground) [-webkit-tap-highlight-color:transparent]"
                  onclick={() => (confirmingDiscard = false)}
                >
                  Cancel
                </button>
              </div>
            {:else}
              <button
                class={LIST_ROW}
                onclick={() => (confirmingDiscard = true)}
                disabled={actions.discarding}
              >
                <span class={LIST_ICON}>
                  {#if actions.discarding}
                    <SpinnerIcon size={16} class="animate-spin" />
                  {:else}
                    <ArrowCounterClockwiseIcon size={16} />
                  {/if}
                </span>
                <span class={LIST_LABEL}>Discard changes</span>
              </button>
            {/if}
          {/if}
        </div>
      {/if}

      <div class={SHEET_CARD}>
        <button
          class={LIST_ROW}
          onclick={openProjectPicker}
        >
          <span class={LIST_ICON}><FolderOpenIcon size={16} /></span>
          <span class={LIST_LABEL}>Project</span>
          <span class={LIST_VALUE}>{projectName}</span>
          <CaretRightIcon size={15} class={ROW_CHEVRON} />
        </button>
        <div class={ROW_DIVIDER}></div>
        <button class={LIST_ROW} onclick={() => handleAction(onOpenServers)}>
          <span class={LIST_ICON}><HardDrivesIcon size={16} /></span>
          <span class={LIST_LABEL}>Host</span>
          <span class={LIST_VALUE}>{serversStore.activeServer?.label ?? ""}</span>
          <CaretRightIcon size={15} class={ROW_CHEVRON} />
        </button>
        <div class={ROW_DIVIDER}></div>
        <button
          class={LIST_ROW}
          onclick={() => handleAction(() => {
            if (session.router.at("settings")) session.closeSettings();
            else session.showSettings();
          })}
        >
          <span class={LIST_ICON}><GearIcon size={16} /></span>
          <span class={LIST_LABEL}>Settings</span>
          <CaretRightIcon size={15} class={ROW_CHEVRON} />
        </button>
      </div>
    </div>
  {/if}
  </div>
</MobileSheet>

<!-- Outside the sheet's subtree: the row that opens it also closes the sheet. -->
{#if publishDialogOpen}
  <PublishRepositoryDialog
    sourceId={composerSourceId}
    onClose={() => (publishDialogOpen = false)}
  />
{/if}

<style>
  /* State icons (sync/commit spinners and checks) grow in rather than pop:
     the swap is a scale + blur entrance keyed on the state, per the Solus
     icon-animation contract (0.25 → 1, blur 4px → 0). */
  .icon-swap {
    display: flex;
    align-items: center;
    justify-content: center;
    animation: icon-swap-in 0.22s cubic-bezier(0.2, 0, 0, 1);
  }

  @keyframes icon-swap-in {
    from {
      opacity: 0;
      transform: scale(0.25);
      filter: blur(0.25rem);
    }
    to {
      opacity: 1;
      transform: scale(1);
      filter: blur(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .icon-swap {
      animation: none;
    }
  }
</style>
