<script lang="ts">
  import {
    ChevronRight as CaretRightIcon,
    GitBranch as GitBranchIcon,
    GitFork as GitForkIcon,
  } from "@lucide/svelte";
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
  } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { worktreeDisplayName } from "../../lib/git-context";
  import { copyText, toasts } from "../../lib/toasts";
  import GitDropdown from "../GitDropdown.svelte";
  import { MiddleTruncate } from "../ui/middle-truncate";
  import { withSelectedWorktree } from "../input/lib/worktree-destination";
  import {
    worktreeProjectRoot,
    type WorktreeEntry,
  } from "@solus/contracts/types";

  interface Props {
    /** The tab or draft whose run this row describes — see `ProjectPanel`. */
    sourceId: string;
  }
  let { sourceId }: Props = $props();

  let branchPickerOpen = $state(false);
  let branchTriggerEl: HTMLButtonElement | null = $state(null);

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const sectionRun = $derived(session.runFor(sourceId));
  const env = $derived(environmentStore.environmentFor(sectionRun));
  const status = $derived(env.status);
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
  const dispatchStartLabel = $derived(sectionRun?.worktree ? "New worktree" : "Checkout");
  const displayedBranch = $derived.by(() => {
    const branch = selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ??
      (pendingDispatch ? dispatchStartLabel : env.pending ? env.name : (currentBranch ?? "detached HEAD"));
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
  const worktrees = $derived(
    environmentStore.refsFor(sectionRun?.serverId ?? session.fallbackServerId, branchRepoRoot).worktrees,
  );

  // Both pickers edit a pre-flight destination. A panel on a session first
  // opens a draft from that source, preserving its project and host.
  function destinationDraft() {
    return session.drafts.sessionDrafts.get(sourceId) ??
      session.drafts.openSessionDraft({ sourceId });
  }

  async function selectBranch(branch: string) {
    if (pendingDispatch) return;
    const entry = worktrees.find((worktree) => worktree.branch === branch);
    if (entry) {
      selectWorktree(entry);
      return;
    }
    const draft = destinationDraft();
    const ok = await session.switchToBranch(branch, draft.id);
    if (ok) settleOnDestination(draft.id);
    else requestInputFocus();
  }

  function selectWorktree(worktree: WorktreeEntry) {
    const projectRoot = branchRepoRoot;
    const targetBranch = env.targetBranch;
    const draft = destinationDraft();
    if (pendingDispatch) {
      session.config.setDispatchWorktree(worktree, draft.id);
      requestInputFocus();
      return;
    }
    draft.run = withSelectedWorktree(
      draft.run, projectRoot, worktree, targetBranch,
    );
    settleOnDestination(draft.id);
  }

  function selectNewDispatchWorktree(baseBranch?: string) {
    const draft = destinationDraft();
    if (baseBranch) session.config.setDispatchBaseBranch(baseBranch, draft.id);
    else session.config.setDispatchWorktree(null, draft.id);
    requestInputFocus();
  }

  function selectDispatchCheckout() {
    session.config.setDispatchCheckout(destinationDraft().id);
    requestInputFocus();
  }

  async function copyBranchName() {
    if (!copyableBranch) return;
    await copyText(copyableBranch);
    toasts.success("Branch name copied");
    requestInputFocus();
  }

  function settleOnDestination(draftId: string) {
    const run = session.runFor(draftId) ?? session.defaultRunConfig;
    const nextCwd = run.gitContext?.worktreePath ?? run.workingDirectory;
    if (nextCwd) void environmentStore.refresh(run.serverId, nextCwd, { force: true });
    requestInputFocus();
  }
</script>

{#if env.branch && status}
  <!-- Split row in the Git rows' language: the branch name copies, the caret
       switches branch or worktree. -->
  <div class="split-row">
    <button
      class="branch-row"
      type="button"
      title={copyableBranch ? `Copy branch name: ${copyableBranch}` : undefined}
      disabled={!copyableBranch}
      onclick={copyBranchName}
    >
      <span class="branch-row-icon"
        >{#if isWorktree || env.pending || pendingDispatch}<GitForkIcon
            size={16}
          />{:else}<GitBranchIcon size={16} />{/if}</span
      >
      <MiddleTruncate value={displayedBranch} class="flex-1" />
    </button>
    <button
      bind:this={branchTriggerEl}
      class="split-caret"
      class:is-open={branchPickerOpen}
      type="button"
      aria-label={pendingDispatch ? "Select a remote worktree" : "Switch branch or worktree"}
      title={pendingDispatch ? "Select a remote worktree" : "Switch branch or worktree"}
      disabled={!currentBranch}
      onclick={() => (branchPickerOpen = !branchPickerOpen)}
    >
      <CaretRightIcon size={11} />
    </button>
  </div>
  {#if currentBranch}
    <GitDropdown
      bind:open={branchPickerOpen}
      side="left"
      triggerEl={branchTriggerEl}
      displayBranch={selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? (pendingDispatch ? dispatchStartLabel : currentBranch)}
      selectedBranch={selectedDispatchWorktree?.branch ?? selectedDispatchBaseBranch ?? sectionRun?.worktree?.baseBranch ?? currentBranch}
      workingDirectory={branchRepoRoot}
      run={sectionRun}
      onSelectBranch={selectBranch}
      onSelectWorktree={selectWorktree}
      onSelectNewWorktree={selectNewDispatchWorktree}
      onSelectDispatchCheckout={selectDispatchCheckout}
    />
  {/if}
{/if}

<style>
  /* Mirrors MenuRow, so the branch reads as the first of the Git rows. */
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
    font-size: inherit;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .branch-row:hover:not(:disabled) {
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
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-text-secondary);
    transition: color 0.15s ease;
  }
  .branch-row:hover:not(:disabled) .branch-row-icon {
    color: var(--solus-text-primary);
  }
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
