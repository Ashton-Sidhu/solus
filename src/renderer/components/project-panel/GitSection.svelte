<script lang="ts">
  import {
    ArrowsClockwiseIcon,
    CheckIcon,
    CaretRightIcon,
    EyeglassesIcon,
    FolderIcon,
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
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
    getSettingsContext,
    getAgentContext,
    toasts,
  } from "../../contexts";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { serversStore } from "../../contexts/connections/servers.store.svelte";
  import GitDropdown from "../GitDropdown.svelte";
  import {
    worktreeProjectRoot,
    type WorktreeEntry,
  } from "../../../shared/types";
  import type { PullRequestSummary } from "../../../shared/providers";

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
  const uncommittedFileCount = $derived(
    status?.uncommittedChanges.files.length ?? 0,
  );
  const insertions = $derived(status?.uncommittedChanges.insertions ?? 0);
  const deletions = $derived(status?.uncommittedChanges.deletions ?? 0);
  const actions = $derived(gitActionsFor(tabId, session, environmentStore));
  const canGit = $derived(!!env.branch);
  const remoteHost = $derived(
    sess?.serverId && sess.serverId !== LOCAL_SERVER_ID
      ? (serversStore.servers.find((server) => server.id === sess.serverId) ?? { label: "remote host" })
      : null,
  );
  const canViewDiff = $derived(!!status);
  const canPr = $derived(!!env.branch && env.branch !== env.targetBranch);
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
    danger?: boolean;
    disabled?: boolean;
    /** Quiet tabular metric or qualifier in the trailing slot ("28", "Ghostty"). */
    badge?: string;
    /** Keyboard hint, set in mono after the badge ("⌥⇧D"). */
    hint?: string;
    tooltip?: string;
    /** Set when the row opens a menu instead of running: the row trades its key
     *  hint for a caret and the click toggles the popover of that name. */
    disclosure?: MenuKey;
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
  const prPhase = $derived<Phase>(
    actions.creatingPR ? "loading" : actions.prError ? "error" : "idle",
  );

  // --- Rows, in the order 5c lays them out. Two of them are disclosures with
  //     their own popover: Commit (its variants and the destructive escape
  //     hatch) and Pull requests (open one, or jump to one that exists). ---
  const actionDefs = $derived.by<ActionDef[]>(() => {
    const defs: ActionDef[] = [
      {
        key: "commit",
        // The row is "Commit"; publishing is a choice inside it, so the panel's
        // headline label no longer changes meaning when a push is configured.
        label: actions.commitPushed
          ? "Committed"
          : actions.commitPushing
            ? "Committing…"
            : "Commit",
        icon: PaperPlaneTiltIcon,
        // No trailing count: the changed-file total already sits on the stats
        // line under the branch, and repeating it here reads as a second,
        // different number.
        phase: commitPhase,
        disclosure: "commit",
        disabled: !canGit,
        run: () => {},
      },
      {
        key: "pull-requests",
        label: actions.creatingPR ? "Opening pull request…" : "Pull requests",
        icon: GitPullRequestIcon,
        phase: prPhase,
        disclosure: "pull-requests",
        disabled: !canViewDiff,
        run: () => {},
      },
      {
        key: "review",
        label: reviewing
          ? reviewKey
            ? "Regenerating report…"
            : "Generating report…"
          : reviewKey
            ? "View report"
            : "Review changes",
        icon: EyeglassesIcon,
        phase: reviewing ? "loading" : reviewKey ? "success" : "idle",
        disabled: !canGit || reviewing,
        run: () => {
          void handleReview();
        },
      },
      {
        key: "working-tree-diff",
        label: "Working tree diff",
        icon: GitCommitIcon,
        hint: comboHint("global.toggle-diff-panel"),
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
        // 5c trails the row with the terminal configured in Settings.
        badge: settings.defaultTerminal === "ghostty" ? "Ghostty" : undefined,
        hint: comboHint("orb.open-terminal"),
        icon: TerminalWindowIcon,
        phase: "idle",
        disabled: !!remoteHost,
        tooltip: remoteHost
          ? `Runs on ${remoteHost.label} — not available for remote sessions`
          : undefined,
        run: () => {
          actions.openTerminal();
          requestInputFocus();
        },
      },
    ];
    // A half-finished merge is an alert, not a menu item — it gets its own row
    // so it's visible without opening anything.
    if (
      status &&
      (status.uncommittedChanges.mergeInProgress || conflictedFiles.length > 0)
    ) {
      defs.push({
        key: "conflict",
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

  // One shared popover anchored to whichever disclosure row is open (mirrors the
  // branch picker's open/triggerEl pattern). Its contents branch on the key.
  type MenuKey = "commit" | "pull-requests";
  let rowMenuOpen = $state(false);
  let openMenuKey = $state<MenuKey | null>(null);
  let openRowEl = $state<HTMLElement | null>(null);

  function toggleRowMenu(key: MenuKey, el: HTMLButtonElement) {
    if (rowMenuOpen && openMenuKey === key) {
      rowMenuOpen = false;
      return;
    }
    openMenuKey = key;
    openRowEl = el.closest(".row-wrap") as HTMLElement | null;
    // Re-arm the destructive step every time the menu is opened, so a discard
    // can never be one stray click away from a menu left in the armed state.
    confirmingDiscard = false;
    rowMenuOpen = true;
    if (key === "pull-requests") void loadOpenPrs();
  }

  function closeRowMenu() {
    rowMenuOpen = false;
    requestInputFocus();
  }

  // The menu's PR list, fetched when that menu opens — nothing on the row itself
  // depends on it, so the panel doesn't pay for a host round-trip on every
  // mount. Read through the store (cached) with an explicit filter rather than
  // `loadAll`, which would stomp the PRs pane's own filter state.
  let openPrs = $state<PullRequestSummary[]>([]);
  async function loadOpenPrs() {
    if (!canViewDiff || !env.cwd) return;
    const ctx = session.ctxForEnvironment(env.cwd, env.checkout, tabId);
    try {
      openPrs = (await session.prsStore.loadFor(ctx, { state: "open" })).items;
    } catch {
      openPrs = [];
    }
  }

  // "Discard changes…" arms in place rather than opening a dialog — the menu
  // swaps to a confirm row, which is what the ellipsis promises.
  let confirmingDiscard = $state(false);

  function runDiscard() {
    closeRowMenu();
    confirmingDiscard = false;
    void actions.discard();
  }

  function openPr(pr: PullRequestSummary) {
    closeRowMenu();
    void session.enterPrReview(pr.number, pr.title, {
      ctx: session.ctxForEnvironment(env.cwd, env.checkout, tabId),
    });
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
  let branchTriggerEl: HTMLButtonElement | null = $state(null);

  const worktrees = $derived(
    environmentStore.refsFor(branchRepoRoot).worktrees,
  );

  function handleReview() {
    if (reviewKey) {
      panes.enterReview(reviewKey);
      requestInputFocus();
      return;
    }
    void generateReport();
  }

  async function generateReport() {
    if (reviewing) return;
    const isRegeneration = !!reviewKey;
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
        toasts.success(isRegeneration ? "Report updated" : "Report ready", {
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

  function regenerateReport() {
    void generateReport();
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

  async function resolveWithAgent() {
    if (
      !status ||
      (!status.uncommittedChanges.mergeInProgress &&
        conflictedFiles.length === 0)
    )
      return;
    const filesToInspect =
      conflictedFiles.length > 0
        ? conflictedFiles
        : status.uncommittedChanges.files;
    const prompt = [
      `Resolve the merge conflicts on branch ${status.branch ?? "detached HEAD"}.`,
      filesToInspect.length > 0
        ? "Files to inspect:"
        : "No conflicted files are currently reported, but a merge operation is still in progress.",
      ...filesToInspect.map((file) => `- ${file.path}`),
      "Inspect the files, resolve the conflicts, and run the relevant checks.",
    ].join("\n");
    await session.startNewSessionWithPrompt(prompt, env.cwd, env.checkout);
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

<!-- A `disclosure` def makes the whole row open its menu rather than run, and
     trades its key hint for a caret — the shortcut is restated beside the same
     action inside the menu. -->
{#snippet menuButton(def: ActionDef, split: boolean)}
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button {...tooltipProps}
    type="button"
    class="menu-row"
    class:split-primary={split}
    class:is-danger={def.danger}
    class:is-success={def.phase === "success"}
    class:is-error={def.phase === "error"}
    class:is-loading={def.phase === "loading"}
    class:is-open={!!def.disclosure && rowMenuOpen && openMenuKey === def.disclosure}
    disabled={def.disabled}
    aria-haspopup={def.disclosure ? "menu" : undefined}
    aria-expanded={def.disclosure ? rowMenuOpen && openMenuKey === def.disclosure : undefined}
    onclick={def.disclosure
      ? (e: MouseEvent & { currentTarget: HTMLButtonElement }) =>
          toggleRowMenu(def.disclosure!, e.currentTarget)
      : def.run}
  >
    <span class="menu-left">
      <span class="menu-icon">{@render actionGlyph(def)}</span>
      <span class="menu-label">{def.label}</span>
    </span>
    <span class="menu-right">
      {#if def.badge}<span class="menu-trail">{def.badge}</span>{/if}
      {#if def.hint && !def.disclosure}<span class="menu-hint">{def.hint}</span>{/if}
      {#if def.disclosure}<span class="menu-caret"><CaretRightIcon size={11} /></span>{/if}
    </span>
  </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={def.tooltip ?? null} />
  </TooltipUI.Root>
{/snippet}

{#snippet actionRow(def: ActionDef)}
  <div class="row-wrap">
    {#if def.key === "review" && (reviewing || reviewKey)}
      <div class="split-row">
        {@render menuButton(def, true)}
        {#if reviewing}
          <button
            type="button"
            class="split-caret is-danger"
            aria-label="Cancel report generation"
            title="Cancel report generation"
            onclick={cancelReview}
          >
            <XIcon size={11} />
          </button>
        {:else}
          <TooltipUI.Root>
            <TooltipUI.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  class="split-caret"
                  aria-label="Regenerate report"
                  onclick={regenerateReport}
                >
                  <ArrowsClockwiseIcon size={12} />
                </button>
              {/snippet}
            </TooltipUI.Trigger>
            <TooltipUI.Content value={"Regenerate report"} />
          </TooltipUI.Root>
        {/if}
      </div>
    {:else}
      {@render menuButton(def, false)}
    {/if}
  </div>
{/snippet}

<!-- 5b's popover vocabulary: 28px rows, 13px labels, no icons — the row you
     opened from already carried the glyph. -->
{#snippet popRow(
  label: string,
  opts: {
    onclick: () => void;
    hint?: string;
    trail?: string;
    emphasis?: boolean;
    danger?: boolean;
    disabled?: boolean;
  },
)}
  <button
    type="button"
    disabled={opts.disabled}
    onclick={opts.onclick}
    class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] lg:text-[0.8125rem] focus-visible:outline-none focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-50 {opts.danger
      ? 'font-normal text-destructive hover:bg-destructive/10 hover:text-destructive'
      : opts.emphasis
        ? 'bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)] font-medium text-(--solus-text-primary) hover:bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)]'
        : 'font-normal text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
  >
    <span class="min-w-0 flex-1 truncate">{label}</span>
    {#if opts.trail}
      <span
        class="shrink-0 text-[0.71875rem] tabular-nums text-(--solus-text-tertiary)"
        >{opts.trail}</span
      >
    {/if}
    {#if opts.hint}<span class="menu-hint">{opts.hint}</span>{/if}
  </button>
{/snippet}

{#snippet popDivider()}
  <div
    class="mx-2 my-[0.3125rem] h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
    aria-hidden="true"
  ></div>
{/snippet}

{#if !env.branch && status === undefined}
  <p class="empty">Loading git status…</p>
{:else if !env.branch && status === null}
  <div class="flex flex-col items-start gap-1 px-2 py-2">
    <span class="text-[0.8125rem] font-secondary text-(--solus-text-secondary)"
      >No Git repository</span
    >
    <span class="text-[0.6875rem] text-(--solus-text-tertiary)">
      Initialize Git to manage branches and changes.
    </span>
  </div>
{:else}
  <div class="env">
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
    <!-- Per 5c the diff stats leave the branch row's trailing slot and sit on
         their own line beneath it, indented to the branch label. -->
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
    <div class="menu-list">
      {#each actionDefs as def (def.key)}
        {@render actionRow(def)}
      {/each}
    </div>
    <Popover.Root bind:open={rowMenuOpen}>
      <Popover.Content
        customAnchor={openRowEl}
        side="left"
        align="start"
        sideOffset={10}
        alignOffset={-6}
        collisionPadding={8}
        onInteractOutside={(event) => {
          // The row is its own trigger — let its click toggle the menu rather
          // than closing here and immediately reopening.
          if ((event.target as Element | null)?.closest?.(".menu-row"))
            event.preventDefault();
        }}
        class="menu-surface z-[10002] w-[264px] gap-0 rounded-lg bg-(--solus-menu-bg) p-1.5 text-menu lg:text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0"
      >
        {#if openMenuKey === "commit"}
          {#if confirmingDiscard}
            <!-- Armed state: the menu becomes the confirmation, so the
                 irreversible action still needs a second, deliberate click. -->
            <p
              class="m-0 px-2 pt-[0.3125rem] pb-[0.4375rem] text-[0.71875rem] leading-[1.5] text-(--solus-text-tertiary)"
            >
              Discards {uncommittedFileCount} uncommitted change{uncommittedFileCount ===
              1
                ? ""
                : "s"}. This can't be undone.
            </p>
            {@render popDivider()}
            {@render popRow("Discard changes", {
              onclick: runDiscard,
              danger: true,
            })}
            {@render popRow("Keep changes", {
              onclick: () => (confirmingDiscard = false),
            })}
          {:else}
            {@render popRow("Commit", {
              onclick: () => {
                closeRowMenu();
                void actions.commit();
              },
              emphasis: true,
              disabled: !canGit || actions.commitPushing,
            })}
            {@render popRow("Commit and push", {
              onclick: () => {
                closeRowMenu();
                void actions.commitPush();
              },
              hint: comboHint("orb.commit-push"),
              disabled: !canGit || actions.commitPushing,
            })}
            {@render popRow(
              actions.synced
                ? "Synced"
                : actions.syncing
                  ? "Syncing…"
                  : "Sync with remote",
              {
                onclick: () => {
                  closeRowMenu();
                  void actions.sync();
                },
                hint: comboHint("orb.sync"),
                disabled: !canGit || actions.syncing,
              },
            )}
            {@render popDivider()}
            {@render popRow("Discard changes…", {
              onclick: () => (confirmingDiscard = true),
              trail:
                uncommittedFileCount > 0
                  ? String(uncommittedFileCount)
                  : undefined,
              danger: true,
              disabled: !canGit || uncommittedFileCount === 0,
            })}
          {/if}
        {:else if openMenuKey === "pull-requests"}
          {#if prUrl}
            {@render popRow("View pull request", {
              onclick: () => {
                closeRowMenu();
                window.solus.openExternal(prUrl);
              },
              emphasis: true,
            })}
          {:else}
            {@render popRow(
              actions.creatingPR ? "Opening pull request…" : "Open pull request",
              {
                onclick: () => {
                  closeRowMenu();
                  void actions.createPR();
                },
                emphasis: true,
                disabled: !canPr || actions.creatingPR,
              },
            )}
          {/if}
          {#if openPrs.length > 0}
            {@render popDivider()}
            <!-- Status is a dot, the number is the row's trailing value. Draft
                 PRs read grey; anything open reads live. -->
            {#each openPrs.slice(0, 5) as pr (pr.number)}
              <button
                type="button"
                onclick={() => openPr(pr)}
                class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[0.8125rem] lg:text-[0.8125rem] font-normal text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary)"
              >
                <span
                  class="size-[0.4375rem] shrink-0 rounded-full"
                  style:background={pr.draft
                    ? "var(--solus-text-tertiary)"
                    : "var(--solus-status-complete)"}
                  aria-hidden="true"
                ></span>
                <span class="min-w-0 flex-1 truncate">{pr.title}</span>
                <span
                  class="shrink-0 text-[0.71875rem] tabular-nums text-(--solus-text-tertiary)"
                  >#{pr.number}</span
                >
              </button>
            {/each}
          {/if}
          {@render popDivider()}
          {@render popRow("Review a PR…", {
            onclick: () => {
              closeRowMenu();
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
          })}
        {/if}
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
    background: color-mix(in srgb, var(--solus-container-border) 55%, transparent);
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
  /* The branch is a disclosure now that the stats have moved off the row, so
     the caret stays visible instead of cross-fading in on hover. */
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
  /* Trailing slot: the row's one metric, then its key hint. */
  .menu-right {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
    min-width: 0;
  }
  /* Regular weight: the row's one metric is quieter than its label, and the
     tabular figures already give it enough presence to scan down the column. */
  .menu-trail {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-size: 0.71875rem;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  /* Disclosure caret closes the row. It points at where the menu opens — the
     menus flank the column rather than dropping into it. */
  .menu-caret {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    opacity: 0.55;
    transition: opacity 0.15s ease;
  }
  .menu-row:hover .menu-caret,
  .menu-row:focus-visible .menu-caret,
  .menu-row.is-open .menu-caret {
    opacity: 1;
  }
  /* An open row keeps the hover wash so it stays tied to its menu. */
  .menu-row.is-open {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .menu-row.is-open .menu-icon {
    color: var(--solus-text-primary);
  }

  /* Key hints are mono and quieter than the metric, so the two never compete. */
  .menu-hint {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-family: var(--solus-code-font-family);
    font-size: 0.65625rem;
    opacity: 0.7;
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
