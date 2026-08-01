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
  import {
    worktreeProjectRoot,
    type WorktreeEntry,
  } from "../../../shared/types";

  interface Props {
    tabId: string;
    active?: boolean;
    onOpenFiles?: () => void;
  }
  let { tabId, active = true, onOpenFiles }: Props = $props();

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const sess = $derived(session.sessionFor(tabId));
  const env = $derived(environmentStore.environmentFor(tabId));
  const status = $derived(env.status);
  const uncommittedFileCount = $derived(
    status?.uncommittedChanges.files.length ?? 0,
  );
  const insertions = $derived(status?.uncommittedChanges.insertions ?? 0);
  const deletions = $derived(status?.uncommittedChanges.deletions ?? 0);
  const actions = $derived(gitActionsFor(tabId, session, environmentStore));
  const currentBranch = $derived(
    status === undefined ? env.branch : (status?.branch ?? null),
  );
  const isWorktree = $derived(env.isolated);
  const branchRepoRoot = $derived(
    env.checkout?.repoRoot ??
      sess?.workingDirectory ??
      status?.repoRoot ??
      worktreeProjectRoot(env.cwd),
  );

  // The host this session was dispatched to. Local is the unmarked case — the
  // affinity glyph is null for it, so the row only exists for remote sessions.
  const host = $derived(serversStore.hostFor(sess?.serverId));
  const hostAffinity = $derived(serversStore.affinityFor(sess?.serverId));

  $effect(() => {
    if (!active || !env.cwd) return;
    return environmentStore.watchDetails(env.cwd);
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
    await session.switchToWorktree(worktree.path);
    settleOnDestination();
  }

  function settleOnDestination() {
    const nextCwd =
      session.activeSession?.gitContext?.worktreePath ??
      session.activeSession?.workingDirectory ??
      session.globalDefaults.gitContext?.worktreePath ??
      session.globalDefaults.workingDirectory;
    if (nextCwd) void environmentStore.refresh(nextCwd, { force: true });
    requestInputFocus();
  }
</script>

<div class="env">
  {#if hostAffinity && host}
    {@const HostIcon = hostAffinity.icon}
    <!-- Read-only: the host is chosen before the session starts and locked
         after, so this row states a fact rather than offering a picker. -->
    <div class="host-row" title={hostAffinity.tooltip}>
      <span class="host-row-icon"
        ><HostIcon size={13} class={hostAffinity.className} /></span
      >
      <span class="host-row-name">{host.label}</span>
      <span class="menu-trail">{hostAffinity.statusLabel}</span>
    </div>
  {/if}
  <!-- Git availability governs only the branch switcher. Files and Terminal
       belong to the environment itself and remain useful outside a repository. -->
  {#if env.branch && status}
    <button
      bind:this={branchTriggerEl}
      class="branch-row"
      type="button"
      title="Switch branch or worktree"
      disabled={!currentBranch || env.pending}
      onclick={() => (branchPickerOpen = !branchPickerOpen)}
    >
      <span class="branch-row-icon"
        >{#if isWorktree || env.pending}<GitForkIcon
            size={13}
          />{:else}<GitBranchIcon size={13} />{/if}</span
      >
      <span class="branch-row-name" title={status?.branch ?? undefined}
        >{env.pending ? env.name : (currentBranch ?? "detached HEAD")}</span
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
        displayBranch={currentBranch}
        selectedBranch={currentBranch}
        workingDirectory={branchRepoRoot}
        onSelectBranch={selectBranch}
        onSelectWorktree={selectWorktree}
      />
    {/if}
    <div class="branch-divider" aria-hidden="true"></div>
  {/if}
  <div class="menu-list">
    {#each actionRows as row (row.key)}
      <MenuRow item={row} onActivate={row.run} />
    {/each}
  </div>
</div>

<style>
  .empty {
    margin: 0;
    padding: 0.125rem 0;
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
  }

  .env {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    margin-bottom: 0.5rem;
  }

  /* Machine → checkout: the host reads in the same voice as the branch row
     beneath it, minus the interactivity. */
  .host-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2rem;
    padding: 0.3125rem 0.5rem;
    color: var(--solus-text-secondary);
    font-size: 0.8125rem;
  }
  .host-row-icon {
    flex-shrink: 0;
    display: inline-flex;
  }
  .host-row-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .menu-trail {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-size: 0.71875rem;
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
    font-size: 0.8125rem;
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
    font-size: 0.6875rem;
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
