<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    BinocularsIcon,
    CheckIcon,
    CaretDownIcon,
    FileIcon,
    GitBranchIcon,
    GitCommitIcon,
    GitForkIcon,
    GitPullRequestIcon,
    PaperPlaneTiltIcon,
    SpinnerGapIcon,
    TerminalWindowIcon,
    WarningCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getGitStatusStore } from "../../contexts/git-status.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { sessionEnvironment } from "../../lib/git-context";
  import { getRecommendedGitActionKey } from "../../lib/git-recommendation";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import Dropdown from "../ui/Dropdown.svelte";
  import DropdownItem from "../ui/DropdownItem.svelte";
  import SearchablePickerList from "../pickers/SearchablePickerList.svelte";
  import {
    worktreeProjectRoot,
    type IpcContext,
    type WorktreeEntry,
  } from "../../../shared/types";

  interface Props {
    cwd: string;
    tabId: string;
    onOpenFiles?: () => void;
  }
  let { cwd, tabId, onOpenFiles }: Props = $props();

  const gitStatus = getGitStatusStore();
  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const av = session.artifactViewer;
  const sess = $derived(session.sessionFor(tabId));
  const status = $derived(gitStatus.statusFor(cwd));
  const conflictedFiles = $derived(
    status?.files.filter((file) => file.conflicted) ?? [],
  );
  const uncommittedFileCount = $derived(status?.files.length ?? 0);
  const insertions = $derived(status?.insertions ?? 0);
  const deletions = $derived(status?.deletions ?? 0);
  const actions = $derived(gitActionsFor(tabId, session, gitStatus));
  const canGit = $derived(!!sess?.gitContext);
  const canViewDiff = $derived(!!status);
  const canPr = $derived(
    !!sess?.gitContext &&
      sess.gitContext.branch !== sess.gitContext.targetBranch,
  );
  const prUrl = $derived(actions.prUrl || status?.prUrl || null);
  const env = $derived(
    sessionEnvironment(
      sess?.gitContext ?? null,
      sess?.worktreeBaseBranch ?? null,
      status ?? null,
    ),
  );
  const currentBranch = $derived(env.branch ?? status?.branch ?? null);
  const isWorktree = $derived(env.isolated);
  const branchRepoRoot = $derived(
    sess?.gitContext?.repoRoot ??
      sess?.workingDirectory ??
      status?.repoRoot ??
      worktreeProjectRoot(cwd),
  );
  const branchRepoCtx = $derived<IpcContext | null>(
    branchRepoRoot && branchRepoRoot !== "~"
      ? session.ctxForDirectory(branchRepoRoot)
      : null,
  );
  const recommendedActionKey = $derived(
    getRecommendedGitActionKey({
      status,
      gitContext: sess?.gitContext,
      prUrl,
      commitPushing: actions.commitPushing,
      syncing: actions.syncing,
      creatingPR: actions.creatingPR,
    }),
  );

  $effect(() => {
    if (cwd) void gitStatus.refresh(cwd);
  });

  // --- Shared action model: every row renders from one definition,
  //     so labels/icons align by construction. ---
  type Phase = "idle" | "loading" | "success" | "error";
  type IconComponent = typeof XIcon;
  interface ActionDef {
    key: string;
    label: string;
    icon: IconComponent;
    phase: Phase;
    primary?: boolean;
    danger?: boolean;
    disabled?: boolean;
    error?: string | null;
    badge?: string;
    run: () => void;
  }

  const commitPhase = $derived<Phase>(
    actions.commitPushing
      ? "loading"
      : actions.commitPushed
        ? "success"
        : actions.commitPushError
          ? "error"
          : "idle",
  );
  const syncPhase = $derived<Phase>(
    actions.syncing
      ? "loading"
      : actions.synced
        ? "success"
        : actions.syncError
          ? "error"
          : "idle",
  );
  const prPhase = $derived<Phase>(
    actions.creatingPR ? "loading" : actions.prError ? "error" : "idle",
  );

  const actionDefs = $derived.by<ActionDef[]>(() => {
    const defs: ActionDef[] = [
      {
        key: "commit",
        primary: recommendedActionKey === "commit",
        label: actions.commitPushed
          ? "Pushed"
          : actions.commitPushing
            ? "Pushing…"
            : "Commit & push",
        icon: PaperPlaneTiltIcon,
        phase: commitPhase,
        disabled: !canGit || actions.commitPushing,
        error: actions.commitPushError,
        run: () => {
          void actions.commitPush();
          requestInputFocus();
        },
      },
      {
        key: "working-tree-diff",
        label: "View working tree diff",
        icon: GitCommitIcon,
        phase: "idle",
        disabled: !canViewDiff,
        run: () => {
          window.dispatchEvent(
            new CustomEvent("solus:toggle-diff-panel", {
              detail: { scope: { kind: "working-tree" }, switchScope: true },
            }),
          );
          requestInputFocus();
        },
      },
      {
        key: "sync",
        primary: recommendedActionKey === "sync",
        label: actions.synced
          ? "Synced"
          : actions.syncing
            ? "Syncing…"
            : "Sync with remote",
        icon: ArrowsClockwiseIcon,
        phase: syncPhase,
        disabled: !canGit || actions.syncing,
        error: actions.syncError,
        run: () => {
          void actions.sync();
          requestInputFocus();
        },
      },
      {
        key: "review",
        label: reviewKey
          ? "View report"
          : reviewing
            ? "Generating report…"
            : "Review changes",
        icon: BinocularsIcon,
        phase: reviewing ? "loading" : "idle",
        disabled: !canGit || reviewing,
        run: () => {
          void handleReview();
        },
      },
      {
        key: "review-pr",
        label: "Review a PR",
        icon: GitPullRequestIcon,
        phase: "idle",
        disabled: !canViewDiff,
        // Reuse the command palette's PR list (the "Review PR…" sub-page).
        run: () => {
          window.dispatchEvent(new CustomEvent("solus:review-pr"));
        },
      },
    ];
    if (prUrl) {
      defs.push({
        key: "pr-view",
        primary: recommendedActionKey === "pr-view",
        label: "View pull request",
        icon: GitPullRequestIcon,
        phase: "idle",
        run: () => {
          window.solus.openExternal(prUrl);
          requestInputFocus();
        },
      });
    } else {
      defs.push({
        key: "pr-create",
        primary: recommendedActionKey === "pr-create",
        label: actions.creatingPR
          ? "Opening pull request…"
          : "Create pull request",
        icon: GitPullRequestIcon,
        phase: prPhase,
        disabled: !canPr || actions.creatingPR,
        error: actions.prError,
        run: () => {
          void actions.createPR();
          requestInputFocus();
        },
      });
    }
    defs.push({
      key: "files",
      label: "File explorer",
      icon: FileIcon,
      phase: "idle",
      disabled: !onOpenFiles,
      run: () => {
        onOpenFiles?.();
      },
    });
    defs.push({
      key: "terminal",
      label: "Open terminal",
      icon: TerminalWindowIcon,
      phase: "idle",
      run: () => {
        actions.openTerminal();
        requestInputFocus();
      },
    });
    if (status && (status.mergeInProgress || conflictedFiles.length > 0)) {
      defs.push({
        key: "conflict",
        primary: recommendedActionKey === "conflict",
        danger: true,
        label:
          conflictedFiles.length > 0
            ? `Resolve ${conflictedFiles.length} conflict${conflictedFiles.length === 1 ? "" : "s"} with agent`
            : "Resolve merge conflicts with agent",
        icon: WarningCircleIcon,
        phase: "idle",
        run: resolveWithAgent,
      });
    }
    return defs;
  });

  // --- Split-button groups: related actions collapse into one row whose primary
  //     is the most relevant action and whose caret reveals the rest. The
  //     source-control primary follows `recommendedActionKey` (the `primary`
  //     flag), so it adapts to context (commit → sync → PR → resolve). Working
  //     tree diff, file explorer and terminal stay as their own plain rows. ---
  interface ActionGroup {
    key: string;
    primary: ActionDef;
    secondary: ActionDef[];
  }
  const actionGroups = $derived.by<ActionGroup[]>(() => {
    const byKey = new Map(actionDefs.map((d) => [d.key, d]));
    const pick = (keys: string[]) =>
      keys
        .map((k) => byKey.get(k))
        .filter((d): d is ActionDef => d !== undefined);

    const groups: ActionGroup[] = [];

    const sourceControl = pick([
      "commit",
      "sync",
      "pr-create",
      "pr-view",
      "conflict",
    ]);
    if (sourceControl.length) {
      const primary =
        sourceControl.find((d) => d.primary) ?? sourceControl[0];
      groups.push({
        key: "source-control",
        primary,
        secondary: sourceControl.filter((d) => d !== primary),
      });
    }

    const review = pick(["review", "review-pr"]);
    if (review.length) {
      groups.push({ key: "review", primary: review[0], secondary: review.slice(1) });
    }

    for (const def of pick(["working-tree-diff", "files", "terminal"])) {
      groups.push({ key: def.key, primary: def, secondary: [] });
    }

    return groups;
  });

  // Secondary-action menu: one shared dropdown anchored to the caret of the
  // currently open group (mirrors the branch picker's open/triggerEl pattern).
  let groupMenuOpen = $state(false);
  let openGroupKey = $state<string | null>(null);
  let openTriggerEl = $state<HTMLButtonElement | null>(null);
  // Anchor the left-popout dropdowns to the side panel's edge (not the button),
  // so they clear the whole project sidebar rather than overlapping it.
  let envEl = $state<HTMLDivElement | null>(null);
  const panelBoundaryEl = $derived(
    (envEl?.closest(".side-panel-root") as HTMLElement | null) ?? null,
  );
  const openGroup = $derived(
    actionGroups.find((g) => g.key === openGroupKey) ?? null,
  );

  function toggleGroup(key: string, el: HTMLButtonElement) {
    if (groupMenuOpen && openGroupKey === key) {
      groupMenuOpen = false;
      return;
    }
    openGroupKey = key;
    openTriggerEl = el;
    groupMenuOpen = true;
  }

  function runSecondary(def: ActionDef) {
    groupMenuOpen = false;
    def.run();
  }

  // Review companion: run the producer (review the diff, enriched by the ledger
  // when present → fixed-structure HTML) for the current branch, then wait for
  // an explicit second click before opening the companion in the main pane.
  let reviewing = $state(false);
  let reviewKey = $state<string | null>(null);

  // The panel survives branch switches; a key latched for the previous branch
  // would open that branch's guide. Reset so "View report" never crosses over.
  $effect(() => {
    void currentBranch;
    reviewKey = null;
  });

  let branchPickerOpen = $state(false);
  let branchTriggerEl: HTMLButtonElement | null = $state(null);
  let branchPickerRef: SearchablePickerList | null = $state(null);
  let branches = $state<string[]>([]);
  let worktrees = $state<WorktreeEntry[]>([]);

  const worktreeBranches = $derived(worktrees.map((wt) => wt.branch));
  const localBranchItems = $derived(
    branches.filter((branch) => !worktreeBranches.includes(branch)),
  );
  const worktreeItems = $derived(worktrees.map((wt) => wt.branch));
  const branchPickerItems = $derived([...localBranchItems, ...worktreeItems]);
  const selectedBranchItem = $derived(currentBranch);

  $effect(() => {
    if (!branchPickerOpen || !branchRepoCtx) return;
    void Promise.all([
      window.solus.worktreeBranches(branchRepoCtx).catch(() => []),
      window.solus.worktreeListProject(branchRepoCtx).catch(() => []),
    ]).then(([nextBranches, nextWorktrees]) => {
      branches = nextBranches;
      worktrees = nextWorktrees;
    });
  });

  $effect(() => {
    if (!branchPickerOpen) {
      branches = [];
      worktrees = [];
      return;
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (branchPickerRef?.handleKeydown(e)) return;
    };
    document.addEventListener("keydown", onKeydown, true);
    return () => document.removeEventListener("keydown", onKeydown, true);
  });

  async function handleReview() {
    if (reviewKey) {
      av.enterReview(reviewKey);
      requestInputFocus();
      return;
    }
    if (reviewing) return;
    reviewing = true;
    try {
      const gen = await window.solus.generateGuide(
        session.ctx,
        resolveReviewAgent(settings, agentContext),
      );
      reviewKey =
        gen?.key ??
        (await window.solus.getReviewContext(session.ctx))?.key ??
        null;
    } finally {
      reviewing = false;
      requestInputFocus();
    }
  }

  function openBranchPicker() {
    if (!currentBranch || env.pending) return;
    branchPickerOpen = !branchPickerOpen;
  }

  async function selectBranchTarget(item: string) {
    branchPickerOpen = false;
    const entry = worktrees.find((wt) => wt.branch === item);
    if (entry) {
      await session.switchToWorktree(entry.path);
    } else {
      const ok = await session.switchToBranch(item);
      if (!ok) {
        requestInputFocus();
        return;
      }
    }
    const nextCwd =
      session.activeSession?.gitContext?.worktreePath ??
      session.activeSession?.workingDirectory ??
      cwd;
    if (nextCwd) void gitStatus.refresh(nextCwd, { force: true });
    requestInputFocus();
  }

  function dismiss() {
    actions.dismissError();
    requestInputFocus();
  }

  async function resolveWithAgent() {
    if (!status || (!status.mergeInProgress && conflictedFiles.length === 0))
      return;
    const filesToInspect =
      conflictedFiles.length > 0 ? conflictedFiles : status.files;
    const prompt = [
      `Resolve the merge conflicts on branch ${status.branch ?? "detached HEAD"}.`,
      filesToInspect.length > 0
        ? "Files to inspect:"
        : "No conflicted files are currently reported, but a merge operation is still in progress.",
      ...filesToInspect.map((file) => `- ${file.path}`),
      "Inspect the files, resolve the conflicts, and run the relevant checks.",
    ].join("\n");
    await session.startNewSessionWithPrompt(
      prompt,
      sess?.workingDirectory ?? status.repoRoot,
      sess?.gitContext ?? null,
    );
    requestInputFocus();
  }
</script>

<!-- ===== Shared building blocks ===== -->
{#snippet actionGlyph(def: ActionDef)}
  {#if def.phase === "loading"}
    <span class="glyph-spin"><SpinnerGapIcon size={13} /></span>
  {:else if def.phase === "success"}
    <span class="glyph-pop"><CheckIcon size={13} weight="bold" /></span>
  {:else}
    {@const Icon = def.icon}
    <Icon size={13} />
  {/if}
{/snippet}

{#snippet inlineError(def: ActionDef)}
  <div class="inline-err" role="alert">
    <WarningCircleIcon size={11} />
    <span>{def.error}</span>
    <button
      class="inline-err-x"
      type="button"
      aria-label="Dismiss error"
      onclick={dismiss}
    >
      <XIcon size={10} />
    </button>
  </div>
{/snippet}

{#snippet branchHeader()}
  <button
    bind:this={branchTriggerEl}
    class="branch-row"
    type="button"
    title="Switch branch or worktree"
    aria-haspopup="menu"
    aria-expanded={branchPickerOpen}
    onclick={openBranchPicker}
  >
    <span class="branch-row-icon">
      {#if isWorktree || env.pending}
        <GitForkIcon size={13} />
      {:else}
        <GitBranchIcon size={13} />
      {/if}
    </span>
    <span class="branch-row-name" title={status?.branch ?? undefined}
      >{env.pending ? env.name : (currentBranch ?? "detached HEAD")}</span
    >
    <span class="branch-row-trail">
      {#if uncommittedFileCount > 0}
        <span class="branch-row-stats">
          <span class="menu-trail">{uncommittedFileCount}</span>
          {#if insertions > 0}
            <span class="stat-add">+{insertions}</span>
          {/if}
          {#if deletions > 0}
            <span class="stat-del">−{deletions}</span>
          {/if}
        </span>
      {/if}
      <span class="branch-row-copy"><CaretDownIcon size={11} /></span>
    </span>
  </button>
{/snippet}

{#snippet menuButton(def: ActionDef, split: boolean)}
  <button
    type="button"
    class="menu-row"
    class:split-primary={split}
    class:is-primary={def.primary}
    class:is-danger={def.danger}
    class:is-success={def.phase === "success"}
    class:is-error={def.phase === "error"}
    class:is-loading={def.phase === "loading"}
    disabled={def.disabled}
    onclick={def.run}
  >
    <span class="menu-left">
      <span class="menu-icon">{@render actionGlyph(def)}</span>
      <span class="menu-label">{def.label}</span>
    </span>
    {#if def.badge}<span class="menu-trail">{def.badge}</span>{/if}
  </button>
{/snippet}

{#snippet groupRow(group: ActionGroup)}
  <div class="row-wrap">
    {#if group.secondary.length === 0}
      {@render menuButton(group.primary, false)}
    {:else}
      <div class="split-row">
        {@render menuButton(group.primary, true)}
        <button
          type="button"
          class="split-caret"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={groupMenuOpen && openGroupKey === group.key}
          onclick={(e) => toggleGroup(group.key, e.currentTarget)}
        >
          <CaretDownIcon size={11} />
        </button>
      </div>
    {/if}
    {#each [group.primary, ...group.secondary] as m (m.key)}
      {#if m.error}{@render inlineError(m)}{/if}
    {/each}
  </div>
{/snippet}

{#if status === undefined}
  <p class="empty">Loading git status…</p>
{:else if status === null}
  <p class="empty">This folder is not a git repository.</p>
{:else}
  <div class="env" bind:this={envEl}>
    {@render branchHeader()}
    <Dropdown
      bind:open={branchPickerOpen}
      triggerEl={branchTriggerEl}
      boundaryEl={panelBoundaryEl}
      width={420}
      align="left"
    >
      <div class="py-1">
        <SearchablePickerList
          bind:this={branchPickerRef}
          items={branchPickerItems}
          selected={selectedBranchItem}
          size="comfortable"
          placeholder="Filter branches and worktrees..."
          emptyLabel="No branches or worktrees found"
          onselect={selectBranchTarget}
        />
      </div>
    </Dropdown>
    <div class="menu-list">
      {#each actionGroups as group (group.key)}
        {@render groupRow(group)}
      {/each}
    </div>
    <Dropdown
      bind:open={groupMenuOpen}
      triggerEl={openTriggerEl}
      boundaryEl={panelBoundaryEl}
      width={220}
      align="left"
    >
      <div class="py-1">
        {#each openGroup?.secondary ?? [] as def (def.key)}
          {@const Icon = def.icon}
          <DropdownItem
            danger={def.danger}
            disabled={def.disabled}
            onclick={() => runSecondary(def)}
          >
            <Icon size={14} />
            <span>{def.label}</span>
          </DropdownItem>
        {/each}
      </div>
    </Dropdown>
  </div>
{/if}

<style>
  .empty {
    margin: 0;
    padding: 0.125rem 0;
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
  }

  /* ============================================================
     Menu language — mirrors the app's native menu rows:
     flat, borderless, accent-light hover, 11px text / 12px icon,
     no fills, no scale. Quiet and premium.
     ============================================================ */
  .env {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    margin-bottom: 0.5rem;
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
    background: var(--solus-accent-light);
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
  .branch-row-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Trailing slot: stats sit in the right-hand icon column (aligned with the
     refresh button above and the Run section's action icons below). The copy
     glyph overlays in the same spot and cross-fades in on hover, so it never
     reserves width that would push the stats out of the column. */
  .branch-row-trail {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
  }
  .branch-row-stats {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-variant-numeric: tabular-nums;
    transition: opacity 0.15s ease;
  }
  .branch-row:hover .branch-row-stats,
  .branch-row:focus-visible .branch-row-stats {
    opacity: 0;
  }
  .stat-add,
  .stat-del {
    font-size: 0.6875rem;
    font-weight: 500;
  }
  .stat-add {
    color: var(--solus-status-complete);
  }
  .stat-del {
    color: var(--solus-status-error);
  }
  .branch-row-copy {
    position: absolute;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    display: inline-flex;
    color: var(--solus-text-tertiary);
    opacity: 0;
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
  .row-wrap {
    display: flex;
    flex-direction: column;
  }

  /* Split-button: primary action + caret that drops the secondary actions.
     The two read as one unit (tight gap), each with the menu-row hover language. */
  .split-row {
    display: flex;
    align-items: stretch;
    gap: 0.0625rem;
  }
  .split-row .split-primary {
    flex: 1;
    min-width: 0;
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
  .split-caret[aria-expanded="true"] {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }
  .split-caret:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }

  .menu-row {
    width: 100%;
    min-height: 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
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
  .menu-row:hover {
    background: var(--solus-accent-light);
    color: var(--solus-text-primary);
  }
  .menu-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .menu-row:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .menu-row.is-loading {
    opacity: 0.85;
  }
  .menu-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .menu-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-text-secondary);
    transition: color 0.15s ease;
  }
  .menu-row:hover .menu-icon {
    color: var(--solus-text-primary);
  }
  .menu-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .menu-trail {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-size: 0.6875rem;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  /* Primary: differentiate with accent ink, not a heavy fill */
  .menu-row.is-primary {
    color: var(--solus-text-primary);
    font-weight: 600;
  }
  .menu-row.is-primary .menu-icon {
    color: var(--solus-text-primary);
  }
  .menu-row.is-primary .menu-trail {
    color: var(--solus-text-secondary);
  }
  .menu-row.is-danger,
  .menu-row.is-danger .menu-icon {
    color: var(--solus-status-error);
  }
  .menu-row.is-danger:hover {
    color: var(--solus-status-error);
    background: var(--solus-status-error-bg);
  }
  .menu-row.is-danger:hover .menu-icon {
    color: var(--solus-status-error);
  }

  .menu-row.is-success,
  .menu-row.is-success .menu-icon {
    color: var(--solus-status-complete);
  }

  /* Glyph state animations (kept subtle) */
  .glyph-spin,
  .glyph-pop {
    display: inline-flex;
  }
  @media (prefers-reduced-motion: no-preference) {
    .glyph-spin {
      animation: glyph-spin 0.7s linear infinite;
    }
    .glyph-pop {
      animation: glyph-pop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }
  @keyframes glyph-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes glyph-pop {
    0% {
      transform: scale(0.5);
      opacity: 0;
    }
    60% {
      transform: scale(1.15);
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .menu-row.is-error {
      animation: shake 0.34s cubic-bezier(0.36, 0.07, 0.19, 0.97);
    }
  }
  @keyframes shake {
    10%,
    90% {
      transform: translateX(-0.0625rem);
    }
    20%,
    80% {
      transform: translateX(0.125rem);
    }
    30%,
    50%,
    70% {
      transform: translateX(-0.125rem);
    }
    40%,
    60% {
      transform: translateX(0.125rem);
    }
  }

  /* Inline error */
  .inline-err {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0.125rem 0 0.0625rem;
    padding: 0.25rem 0.3125rem 0.25rem 0.5rem;
    border-radius: 0.375rem;
    background: var(--solus-status-error-bg);
    color: var(--solus-status-error);
    font-size: 0.6875rem;
    line-height: 1.35;
  }
  @media (prefers-reduced-motion: no-preference) {
    .inline-err {
      animation: err-slide 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }
  .inline-err span {
    min-width: 0;
    flex: 1;
  }
  .inline-err-x {
    width: 1.125rem;
    height: 1.125rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: 0;
    border: none;
    border-radius: 0.25rem;
    background: transparent;
    color: var(--solus-status-error);
    cursor: pointer;
  }
  .inline-err-x:hover {
    background: color-mix(in srgb, var(--solus-status-error) 14%, transparent);
  }
  @keyframes err-slide {
    from {
      opacity: 0;
      transform: translateY(-0.125rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
