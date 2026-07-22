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
  import { getSessionEnvironmentStore } from "../../contexts/session-environment.store.svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { getSettingsContext } from "../../contexts/settings.context.svelte";
  import { getAgentContext } from "../../contexts/agent.context.svelte";
  import { toasts } from "../../contexts/toast.store.svelte";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { getRecommendedGitActionKey } from "../../lib/git-recommendation";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as Popover from "../ui/popover";
  import SearchablePickerList from "../pickers/SearchablePickerList.svelte";
  import {
    worktreeProjectRoot,
    type IpcContext,
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
  const agentContext = getAgentContext();
  const panes = session.panes;
  const sess = $derived(session.sessionFor(tabId));
  const env = $derived(environmentStore.environmentFor(tabId));
  const cwd = $derived(env.cwd);
  const status = $derived(env.status);
  const conflictedFiles = $derived(
    status?.uncommittedChanges.files.filter((file) => file.conflicted) ?? [],
  );
  const uncommittedFileCount = $derived(status?.uncommittedChanges.files.length ?? 0);
  const insertions = $derived(status?.uncommittedChanges.insertions ?? 0);
  const deletions = $derived(status?.uncommittedChanges.deletions ?? 0);
  const actions = $derived(gitActionsFor(tabId, session, environmentStore));
  const canGit = $derived(!!env.branch);
  const canViewDiff = $derived(!!status);
  const canPr = $derived(
    !!env.branch && env.branch !== env.targetBranch,
  );
  const prUrl = $derived(actions.prUrl || status?.prUrl || null);
  const currentBranch = $derived(
    status === undefined ? env.branch : (status?.branch ?? null),
  );
  const isWorktree = $derived(env.isolated);
  const branchRepoRoot = $derived(
    env.checkout?.repoRoot ??
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
    if (!active || !cwd) return;
    return environmentStore.watchDetails(cwd);
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
              detail: {
                scope: { kind: "working-tree" },
                switchScope: true,
                cwd: env.cwd,
                checkout: env.checkout,
              },
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
        run: () => {
          void actions.sync();
          requestInputFocus();
        },
      },
      {
        key: "review",
        label: reviewing
          ? "Generating report…"
          : reviewKey
            ? "View report"
            : "Review changes",
        icon: BinocularsIcon,
        phase: reviewing ? "loading" : reviewKey ? "success" : "idle",
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
          window.dispatchEvent(
            new CustomEvent("solus:review-pr", {
              detail: {
                tabId: tabId || undefined,
                cwd: env.cwd,
                checkout: env.checkout,
              },
            }),
          );
        },
      },
    ];
    if (reviewKey) {
      defs.push({
        key: "review-regenerate",
        label: "Regenerate report",
        icon: ArrowsClockwiseIcon,
        phase: "idle",
        disabled: reviewing,
        run: () => {
          void handleReview(true);
        },
      });
    }
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
    if (status && (status.uncommittedChanges.mergeInProgress || conflictedFiles.length > 0)) {
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

    const review = pick(["review", "review-regenerate", "review-pr"]);
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
  let openRowEl = $state<HTMLElement | null>(null);
  const openGroup = $derived(
    actionGroups.find((g) => g.key === openGroupKey) ?? null,
  );

  function toggleGroup(key: string, el: HTMLButtonElement) {
    if (groupMenuOpen && openGroupKey === key) {
      groupMenuOpen = false;
      return;
    }
    openGroupKey = key;
    openRowEl = el.closest(".row-wrap") as HTMLElement | null;
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
  let reviewRunId = 0;

  // The panel survives branch switches; a key latched for the previous branch
  // would open that branch's guide. Reset so "View report" never crosses over.
  $effect(() => {
    void currentBranch;
    reviewKey = null;
  });

  let branchPickerOpen = $state(false);
  let branchPickerRef: SearchablePickerList | null = $state(null);

  const branchRefs = $derived(environmentStore.refsFor(branchRepoRoot));
  const branches = $derived(branchRefs.branches);
  const worktrees = $derived(branchRefs.worktrees);
  const worktreeBranches = $derived(worktrees.map((wt) => wt.branch));
  const localBranchItems = $derived(
    branches.filter((branch) => !worktreeBranches.includes(branch)),
  );
  const worktreeItems = $derived(worktrees.map((wt) => wt.branch));
  const branchPickerItems = $derived([...localBranchItems, ...worktreeItems]);
  const selectedBranchItem = $derived(currentBranch);

  function handleBranchOpenChange(next: boolean) {
    branchPickerOpen = next;
    if (next && branchRepoCtx) {
      void environmentStore.refreshRefs(branchRepoRoot, branchRepoCtx, { force: true }).then((ok) => {
        if (!ok) toasts.error("Couldn't refresh branches");
      });
    }
  }

  $effect(() => {
    if (!branchPickerOpen) {
      return;
    }
    const onKeydown = (e: KeyboardEvent) => {
      if (branchPickerRef?.handleKeydown(e)) return;
    };
    document.addEventListener("keydown", onKeydown, true);
    return () => document.removeEventListener("keydown", onKeydown, true);
  });

  async function handleReview(regenerate = false) {
    if (reviewKey && !regenerate) {
      panes.enterReview(reviewKey);
      requestInputFocus();
      return;
    }
    if (reviewing) return;
    const runId = ++reviewRunId;
    const ctx = session.ctxForEnvironment(env.cwd, env.checkout, tabId);
    reviewing = true;
    try {
      const gen = await window.solus.generateGuide(
        ctx,
        resolveReviewAgent(settings, agentContext),
      );
      if (runId !== reviewRunId) return;
      // Fallback guides are intentionally not persisted. Only offer "View
      // report" when generation returned a real cached guide.
      const generatedKey = gen?.persisted ? gen.key : null;
      if (generatedKey) {
        reviewKey = generatedKey;
        toasts.success(regenerate ? "Report regenerated" : "Report ready", {
          action: {
            label: "View",
            onAction: () => {
              panes.enterReview(generatedKey);
              requestInputFocus();
            },
          },
        });
      } else if (gen) {
        toasts.info(gen.guide.summary);
      }
    } catch (error) {
      if (runId === reviewRunId) {
        toasts.error(
          `Couldn't generate report: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (runId === reviewRunId) {
        reviewing = false;
        requestInputFocus();
      }
    }
  }

  function cancelReview() {
    if (!reviewing) return;
    reviewRunId += 1;
    reviewing = false;
    void window.solus.cancelGenerateGuide(
      session.ctxForEnvironment(env.cwd, env.checkout, tabId),
    );
    requestInputFocus();
  }

  async function selectBranchTarget(item: string) {
    branchPickerOpen = false;
    const entry = worktrees.find((wt) => wt.branch === item);
    if (entry) {
      await session.switchToWorktree(entry.path, tabId || undefined);
    } else {
      const ok = await session.switchToBranch(item, tabId || undefined);
      if (!ok) {
        requestInputFocus();
        return;
      }
    }
    const nextSession = tabId ? session.sessionFor(tabId) : undefined;
    const nextCwd =
      nextSession?.gitContext?.worktreePath ??
      nextSession?.workingDirectory ??
      session.globalDefaults.gitContext?.worktreePath ??
      session.globalDefaults.workingDirectory;
    if (nextCwd) void environmentStore.refresh(nextCwd, { force: true });
    requestInputFocus();
  }

  async function resolveWithAgent() {
    if (!status || (!status.uncommittedChanges.mergeInProgress && conflictedFiles.length === 0))
      return;
    const filesToInspect =
      conflictedFiles.length > 0 ? conflictedFiles : status.uncommittedChanges.files;
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
      env.cwd,
      env.checkout,
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
    {#if group.primary.key === "review" && reviewing}
      <div class="split-row">
        {@render menuButton(group.primary, true)}
        <button
          type="button"
          class="split-caret is-danger"
          aria-label="Cancel report generation"
          title="Cancel report generation"
          onclick={cancelReview}
        >
          <XIcon size={11} />
        </button>
      </div>
    {:else if group.secondary.length === 0}
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
  </div>
{/snippet}

{#if !env.branch && status === undefined}
  <p class="empty">Loading git status…</p>
{:else if !env.branch && status === null}
  <div class="flex flex-col items-start gap-1 px-2 py-2">
    <span class="text-[0.8125rem] text-(--solus-text-secondary)">No Git repository</span>
    <span class="text-[0.6875rem] text-(--solus-text-tertiary)">
      Initialize Git to manage branches and changes.
    </span>
  </div>
{:else}
  <div class="env">
    <Popover.Root bind:open={branchPickerOpen} onOpenChange={handleBranchOpenChange}>
      <Popover.Trigger disabled={!currentBranch || env.pending}>
        {#snippet child({ props })}
          <button {...props} class="branch-row" type="button" title="Switch branch or worktree">
            <span class="branch-row-icon">{#if isWorktree || env.pending}<GitForkIcon size={13} />{:else}<GitBranchIcon size={13} />{/if}</span>
            <span class="branch-row-name" title={status?.branch ?? undefined}>{env.pending ? env.name : (currentBranch ?? "detached HEAD")}</span>
            <span class="branch-row-trail">
              {#if uncommittedFileCount > 0}
                <span class="branch-row-stats">
                  <span class="menu-trail">{uncommittedFileCount}{status?.uncommittedChanges.hasMoreFiles ? "+" : ""}</span>
                  {#if insertions > 0}<span class="stat-add">+{insertions}</span>{/if}
                  {#if deletions > 0}<span class="stat-del">−{deletions}</span>{/if}
                </span>
              {/if}
              <span class="branch-row-copy"><CaretDownIcon size={11} /></span>
            </span>
          </button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content side="left" align="start" sideOffset={6} collisionPadding={8} onOpenAutoFocus={(event) => event.preventDefault()} class="z-[10002] w-[420px] gap-0 overflow-hidden rounded-xl border-(--solus-popover-border) bg-(--solus-popover-bg) p-0 py-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
        <SearchablePickerList
          bind:this={branchPickerRef}
          items={branchPickerItems}
          selected={selectedBranchItem}
          size="comfortable"
          placeholder="Filter branches and worktrees..."
          emptyLabel="No branches or worktrees found"
          onselect={selectBranchTarget}
        />
      </Popover.Content>
    </Popover.Root>
    <div class="menu-list">
      {#each actionGroups as group (group.key)}
        {@render groupRow(group)}
      {/each}
    </div>
    <Popover.Root bind:open={groupMenuOpen}>
      <Popover.Content customAnchor={openRowEl} side="left" align="start" sideOffset={6} collisionPadding={8} onInteractOutside={(event) => { if ((event.target as Element | null)?.closest?.(".split-caret")) event.preventDefault() }} class="z-[10002] w-[220px] gap-0 overflow-hidden rounded-xl border-(--solus-popover-border) bg-(--solus-popover-bg) p-1 shadow-(--solus-popover-shadow) ring-0 backdrop-blur-xl">
        {#each openGroup?.secondary ?? [] as def (def.key)}
          {@const Icon = def.icon}
          <button
            type="button"
            disabled={def.disabled}
            onclick={() => runSecondary(def)}
            class="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[0.6875rem] lg:text-xs text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-50 {def.danger ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : ''}"
          >
            <Icon size={14} />
            <span>{def.label}</span>
          </button>
        {/each}
      </Popover.Content>
    </Popover.Root>
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
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .split-caret.is-danger {
    color: var(--solus-status-error);
  }
  .split-caret.is-danger:hover {
    background: var(--solus-status-error-bg);
    color: var(--solus-status-error);
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
    background: var(--solus-surface-hover);
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
    font-weight: 500;
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
</style>
