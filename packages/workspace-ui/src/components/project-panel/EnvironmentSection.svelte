<script lang="ts">
  import {
    ChevronRight as CaretRightIcon,
    Copy as CopyIcon,
    Eraser as EraserIcon,
    Folder as FolderIcon,
    GitBranch as GitBranchIcon,
    GitFork as GitForkIcon,
    Globe as GlobeIcon,
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
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { worktreeDisplayName } from "../../lib/git-context";
  import { copyText, toasts } from "../../lib/toasts";
  import GitDropdown from "../GitDropdown.svelte";
  import TerminalAppLogo from "../settings/TerminalAppLogo.svelte";
  import MenuRow, { type ActionRowItem } from "./MenuRow.svelte";
  import UsageMeters from "./UsageMeters.svelte";
  import {
    clearedBrowserDataLabel,
    clearBrowserDataLabel,
    confirmClearBrowserDataLabel,
    isClearBrowserArmed,
    browserProfileProject,
  } from "./lib/browser-row";
  import {
    worktreeProjectRoot,
    type WorktreeEntry,
  } from "@solus/contracts/types";
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
  const status = $derived(env.status);
  const uncommittedFileCount = $derived(
    status?.uncommittedChanges.files.length ?? 0,
  );
  const insertions = $derived(status?.uncommittedChanges.insertions ?? 0);
  const deletions = $derived(status?.uncommittedChanges.deletions ?? 0);
  const actions = $derived(gitActionsFor(sourceId, session, environmentStore, pullRequests.projects));
  const currentBranch = $derived(
    status === undefined ? env.branch : (status?.branch ?? null),
  );
  const pendingDispatch = $derived(
    sectionRun?.pendingHostDispatch?.intent === "dispatch"
      ? sectionRun.pendingHostDispatch
      : null,
  );
  const selectedDispatchWorktree = $derived(pendingDispatch?.worktree ?? null);
  const selectedDispatchBaseBranch = $derived(pendingDispatch?.baseBranch ?? null);
  const isWorktree = $derived(env.isolated);
  const displayedBranch = $derived.by(() => {
    const branch = selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ??
      (pendingDispatch ? "New worktree" : env.pending ? env.name : (currentBranch ?? "detached HEAD"));
    return selectedDispatchWorktree || isWorktree ? worktreeDisplayName(branch) : branch;
  });
  const copyableBranch = $derived(
    selectedDispatchWorktree?.branch ??
      selectedDispatchBaseBranch ??
      (pendingDispatch ? null : currentBranch),
  );
  const branchRepoRoot = $derived(
    env.checkout?.repoRoot ??
      sectionRun?.workingDirectory ??
      status?.repoRoot ??
      worktreeProjectRoot(env.cwd),
  );

  // The host this session was dispatched to, or a draft will dispatch to. The
  // section header names it; here it only governs which actions can run — local
  // is the unmarked case, so the affinity glyph is null for it.
  const host = $derived(serversStore.hostFor(sectionRun?.serverId));
  const hostAffinity = $derived(serversStore.affinityFor(sectionRun?.serverId));

  $effect(() => {
    if (!active || !detailCwd) return;
    return environmentStore.watchDetails(detailServerId, detailCwd);
  });

  // Clearing the browser profile arms in place, the way "Discard changes…"
  // does in the Git section: the row itself becomes the confirmation, so an
  // action that signs the user out everywhere still costs a second, deliberate
  // click, and the caret beside it is the way back out.
  let clearBrowserArmedFor = $state<string | null>(null);
  const confirmingClearBrowser = $derived(
    isClearBrowserArmed(clearBrowserArmedFor, branchRepoRoot),
  );
  const browserProject = $derived(browserProfileProject(branchRepoRoot));

  const actionRows = $derived.by<(ActionRowItem & { run: () => void })[]>(
    () => [
      {
        key: "files",
        label: "Files",
        icon: FolderIcon,
        hint: comboHint("global.toggle-files"),
        phase: "idle",
        disabled: !onOpenFiles,
        run: () => {
          onOpenFiles?.();
        },
      },
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
    ],
  );

  let branchPickerOpen = $state(false);
  let branchTriggerEl: HTMLButtonElement | null = $state(null);

  const worktrees = $derived(
    environmentStore.refsFor(branchRepoRoot).worktrees,
  );

  // Environment selection is navigation, not an in-place retarget of this
  // panel's tab. Omitting tabId lets the workspace preserve a started session
  // and create/activate a destination tab in the selected environment group.
  async function selectBranch(branch: string) {
    if (pendingDispatch) return;
    // A branch already checked out somewhere *is* that worktree, so the picker's
    // "Checked out" rows move there rather than checking it out again here.
    const entry = worktrees.find((wt) => wt.branch === branch);
    if (entry) {
      await selectWorktree(entry);
      return;
    }
    const ok = await session.switchToBranch(branch);
    if (!ok) {
      requestInputFocus();
      return;
    }
    settleOnDestination();
  }

  async function selectWorktree(worktree: WorktreeEntry) {
    if (pendingDispatch) {
      session.setDispatchWorktree(worktree, sourceId);
      requestInputFocus();
      return;
    }
    await session.switchToWorktree(worktree.path);
    settleOnDestination();
  }

  function selectNewDispatchWorktree(baseBranch?: string) {
    if (baseBranch) session.setDispatchBaseBranch(baseBranch, sourceId);
    else session.setDispatchWorktree(null, sourceId);
    requestInputFocus();
  }

  async function copyBranchName() {
    if (!copyableBranch) return;
    await copyText(copyableBranch);
    toasts.success("Branch name copied");
    requestInputFocus();
  }

  async function clearBrowserData() {
    clearBrowserArmedFor = null;
    const project = browserProject;
    try {
      await browserStore.clearProfile(
        detailServerId,
        browserPartition(branchRepoRoot ?? undefined),
      );
      toasts.success(clearedBrowserDataLabel(project));
    } catch (error) {
      toasts.error("Couldn't clear the browser data", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
    requestInputFocus();
  }

  function settleOnDestination() {
    const nextCwd =
      session.activeSession?.run.gitContext?.worktreePath ??
      session.activeSession?.run.workingDirectory ??
      session.globalDefaults.gitContext?.worktreePath ??
      session.globalDefaults.workingDirectory;
    if (nextCwd) void environmentStore.refresh(nextCwd, { force: true });
    requestInputFocus();
  }
</script>

<div class="env">
  <!-- Git availability governs only the branch switcher. Files and Terminal
       belong to the environment itself and remain useful outside a repository. -->
  {#if env.branch && status}
    <div class="branch-control">
      <button
        class="branch-row"
        type="button"
        title={copyableBranch ? `Copy branch name: ${copyableBranch}` : undefined}
        disabled={!copyableBranch}
        onclick={copyBranchName}
      >
        <span class="branch-row-icon"
          >{#if isWorktree || env.pending || pendingDispatch}<GitForkIcon
              size={13}
            />{:else}<GitBranchIcon size={13} />{/if}</span
        >
        <span class="branch-row-name" title={displayedBranch}
          >{displayedBranch}</span
        >
        {#if copyableBranch}
          <span class="branch-copy-indicator" aria-hidden="true">
            <CopyIcon size={11} />
          </span>
        {/if}
      </button>
      <!-- The branch value copies directly. The disclosure remains a separate
           keyboard target for switching branches or worktrees. -->
      <button
        bind:this={branchTriggerEl}
        class="branch-picker-trigger"
        type="button"
        aria-label={pendingDispatch ? "Select a remote worktree" : "Switch branch or worktree"}
        title={pendingDispatch ? "Select a remote worktree" : "Switch branch or worktree"}
        disabled={!currentBranch || (env.pending && !pendingDispatch)}
        onclick={() => (branchPickerOpen = !branchPickerOpen)}
      >
        <CaretRightIcon size={11} />
      </button>
    </div>
    <!-- The diff stats sit on their own line beneath the branch, indented to
         the branch label. -->
    {#if uncommittedFileCount > 0}
      <div class="branch-stats-line">
        <span class="menu-trail"
          >{uncommittedFileCount}{status?.uncommittedChanges.hasMoreFiles
            ? "+"
            : ""} files</span
        >
        {#if insertions > 0}<span class="stat-add">+{insertions}</span>{/if}
        {#if deletions > 0}<span class="stat-del">−{deletions}</span>{/if}
      </div>
    {/if}
    {#if currentBranch}
      <GitDropdown
        bind:open={branchPickerOpen}
        side="left"
        triggerEl={branchTriggerEl}
        displayBranch={selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? (pendingDispatch ? "New worktree" : currentBranch)}
        selectedBranch={selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? currentBranch}
        workingDirectory={branchRepoRoot}
        run={sectionRun}
        onSelectBranch={selectBranch}
        onSelectWorktree={selectWorktree}
        onSelectNewWorktree={selectNewDispatchWorktree}
      />
    {/if}
    <div class="branch-divider" aria-hidden="true"></div>
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
                : branchRepoRoot)}
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
  .empty {
    margin: 0;
    padding: 0.125rem 0;
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
  }

  .env {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    margin-bottom: 0.5rem;
  }

  .menu-trail {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-size: var(--text-xs);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .branch-row {
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2rem;
    padding: 0.3125rem 0.5rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-secondary);
    /* Match MenuRow by inheriting the project rail's device-based type rung. */
    font-size: inherit;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .branch-row:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .branch-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .branch-row:disabled {
    cursor: default;
  }
  .branch-row-icon {
    flex-shrink: 0;
    color: var(--solus-text-secondary);
    transition: color 0.15s ease;
  }
  .branch-row:hover .branch-row-icon {
    color: var(--solus-text-primary);
  }
  .branch-copy-indicator {
    flex-shrink: 0;
    display: inline-flex;
    color: var(--solus-text-tertiary);
    opacity: 0.55;
    transition: opacity 0.15s ease;
  }
  .branch-row:hover .branch-copy-indicator,
  .branch-row:focus-visible .branch-copy-indicator {
    opacity: 1;
  }
  /* The branch is the section's anchor — a constant half-step heavier than
     the action rows beneath it. */
  .branch-row-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .branch-control {
    display: flex;
    align-items: stretch;
    gap: 0.0625rem;
  }
  .branch-picker-trigger {
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
    opacity: 0.55;
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease;
  }
  .branch-picker-trigger:hover,
  .branch-picker-trigger:focus-visible {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
    opacity: 1;
  }
  .branch-picker-trigger:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .branch-picker-trigger:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  /* Stats line beneath the branch, indented past the branch icon (13px glyph +
     0.5rem gap) so it hangs under the branch name. */
  .branch-stats-line {
    display: flex;
    align-items: center;
    gap: 0.5625rem;
    padding: 0.0625rem 0.5rem 0 1.8125rem;
    font-variant-numeric: tabular-nums;
  }
  .branch-divider {
    height: 1px;
    margin: 0.5rem 0.5rem 0.375rem;
    background: color-mix(
      in srgb,
      var(--solus-container-border) 55%,
      transparent
    );
  }
  .stat-add,
  .stat-del {
    font-size: var(--text-xs);
    font-weight: 400;
  }
  .stat-add {
    color: var(--solus-status-complete);
  }
  .stat-del {
    color: var(--solus-status-error);
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
