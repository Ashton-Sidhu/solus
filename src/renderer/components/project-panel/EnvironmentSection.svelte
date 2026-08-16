<script lang="ts">
  import {
    CaretRightIcon,
    FolderIcon,
    GitBranchIcon,
    GitForkIcon,
    TerminalWindowIcon,
  } from "phosphor-svelte";
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
    getSettingsContext,
    serversStore,
  } from "../../contexts";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { requestInputFocus } from "../../lib/inputFocus";
  import GitDropdown from "../GitDropdown.svelte";
  import MenuRow, { type ActionRowItem } from "./MenuRow.svelte";
  import UsageMeters from "./UsageMeters.svelte";
  import {
    worktreeProjectRoot,
    type WorktreeEntry,
  } from "../../../shared/types";
  import { serverConnections } from "@client-core/server-connections";

  interface Props {
    /** The tab or draft whose run this section describes — see `ProjectPanel`. */
    sourceId: string;
    active?: boolean;
    onOpenFiles?: () => void;
  }
  let { sourceId, active = true, onOpenFiles }: Props = $props();

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const settings = getSettingsContext();
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
  const actions = $derived(gitActionsFor(sourceId, session, environmentStore));
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

  const actionRows = $derived.by<(ActionRowItem & { run: () => void })[]>(
    () => [
      {
        key: "files",
        label: "Files",
        icon: FolderIcon,
        phase: "idle",
        disabled: !onOpenFiles,
        run: () => {
          onOpenFiles?.();
        },
      },
      {
        key: "terminal",
        label: "Terminal",
        // The row trails with the terminal configured in Settings.
        badge: settings.defaultTerminal === "ghostty" ? "Ghostty" : undefined,
        hint: comboHint("orb.open-terminal"),
        icon: TerminalWindowIcon,
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
    <button
      bind:this={branchTriggerEl}
      class="branch-row"
      type="button"
      title={pendingDispatch ? "Select a remote worktree" : "Switch branch or worktree"}
      disabled={!currentBranch || (env.pending && !pendingDispatch)}
      onclick={() => (branchPickerOpen = !branchPickerOpen)}
    >
      <span class="branch-row-icon"
        >{#if isWorktree || env.pending || pendingDispatch}<GitForkIcon
            size={13}
          />{:else}<GitBranchIcon size={13} />{/if}</span
      >
      <span class="branch-row-name" title={status?.branch ?? undefined}
        >{selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? (pendingDispatch ? "New worktree" : env.pending ? env.name : (currentBranch ?? "detached HEAD"))}</span
      >
      <!-- Disclosure, not a dropdown: the picker flanks the column rather than
           dropping into it, so the row reads like a submenu. -->
      <span class="branch-row-trail">
        <span class="branch-row-copy"><CaretRightIcon size={11} /></span>
      </span>
    </button>
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
      <MenuRow item={row} onActivate={row.run} />
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
    font-size: var(--text-menu-meta);
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
    font-size: var(--text-menu-meta);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }

  .branch-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2rem;
    padding: 0.3125rem 0.5rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-secondary);
    /* Same token as MenuRow: the branch row anchors the same menu language. */
    font-size: var(--text-menu);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  @container (max-width: 15rem) {
    .branch-row {
      font-size: 0.75rem;
    }
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
  .branch-row-icon {
    flex-shrink: 0;
    color: var(--solus-text-secondary);
    transition: color 0.15s ease;
  }
  .branch-row:hover .branch-row-icon {
    color: var(--solus-text-primary);
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
  /* Trailing slot: just the disclosure caret, in the right-hand icon column
     aligned with the refresh button above. */
  .branch-row-trail {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
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
    font-size: var(--text-menu-meta);
    font-weight: 400;
  }
  .stat-add {
    color: var(--solus-status-complete);
  }
  .stat-del {
    color: var(--solus-status-error);
  }
  /* The branch is a disclosure, so the caret stays visible instead of
     cross-fading in on hover. */
  .branch-row-copy {
    display: inline-flex;
    color: var(--solus-text-tertiary);
    opacity: 0.55;
    transition: opacity 0.15s ease;
  }
  .branch-row:hover .branch-row-copy,
  .branch-row:focus-visible .branch-row-copy {
    opacity: 1;
  }

  .menu-list {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }
</style>
