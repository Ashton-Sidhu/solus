<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import {
    ArrowsClockwiseIcon,
    CaretRightIcon,
    EyeglassesIcon,
    GitCommitIcon,
    GitPullRequestIcon,
    PaperPlaneTiltIcon,
    WarningCircleIcon,
    XIcon,
  } from "phosphor-svelte";
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
    getSettingsContext,
    getAgentContext,
  } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { gitActionsFor } from "../../lib/git-actions.svelte";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { resolveReviewAgent } from "../../lib/reviewAgent";
  import { requestInputFocus } from "../../lib/inputFocus";
  import {
    branchGuideIdentity,
    reviewGuideStore,
  } from "../review/review-guide.store.svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import * as Popover from "../ui/popover";
  import MenuRow, { type ActionRowItem } from "./MenuRow.svelte";
  import { checksPresentation } from "../prs/lib/checks";
  import type { PullRequestSummary } from "../../../shared/providers";
  import { serverConnections } from "@client-core/server-connections";
  import { primaryGitAction } from "./lib/git-action-selection";
  import CommitComposer from "./commit-composer/CommitComposer.svelte";

  interface Props {
    /** The tab or draft whose run this section describes — see `ProjectPanel`. */
    sourceId: string;
  }
  let { sourceId }: Props = $props();

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const prApi = $derived(session.apiFor(sourceId));
  const prServerId = $derived(serverConnections.serverIdForApi(prApi));
  const env = $derived(environmentStore.environmentFor(session.runFor(sourceId)));
  const detailCwd = $derived(env.cwd);
  const detailServerId = $derived(prServerId);
  const status = $derived(env.status);
  const conflictedFiles = $derived(
    status?.uncommittedChanges.files.filter((file) => file.conflicted) ?? [],
  );
  const uncommittedFileCount = $derived(
    status?.uncommittedChanges.files.length ?? 0,
  );
  const actions = $derived(gitActionsFor(sourceId, session, environmentStore));
  const canGit = $derived(!!env.branch);
  const canViewDiff = $derived(!!status);
  const prUrl = $derived(actions.prUrl || status?.prUrl || null);
  const primaryAction = $derived(primaryGitAction(status));
  const isCommitActionRunning = $derived(
    actions.running &&
      (actions.activeAction === "commit" ||
        actions.activeAction === "commit_push" ||
        actions.activeAction === "commit_push_pull_request"),
  );
  const isPullRequestActionRunning = $derived(
    actions.running &&
      (actions.activeAction === "create_pull_request" ||
        actions.activeAction === "commit_push_pull_request"),
  );
  const currentBranch = $derived(
    status === undefined ? env.branch : (status?.branch ?? null),
  );

  // --- Shared action model: every row renders from one definition,
  //     so labels/icons align by construction. ---
  interface ActionDef extends ActionRowItem {
    disclosure?: MenuKey;
    secondaryMenu?: MenuKey;
    run: () => void;
  }

  const commitPhase = $derived<ActionDef["phase"]>(
    isCommitActionRunning &&
    (actions.activePhase === "branch" || actions.activePhase === "commit")
      ? "loading"
      : actions.lastResult?.commit.status === "created"
        ? "success"
        : actions.actionError
          ? "error"
          : "idle",
  );
  const prPhase = $derived<ActionDef["phase"]>(
    isPullRequestActionRunning
      ? "loading"
      : actions.lastResult?.pullRequest.status !== "skipped" &&
          actions.lastResult?.pullRequest !== undefined
        ? "success"
        : actions.actionError
          ? "error"
          : "idle",
  );

  function runPrimaryAction() {
    if (primaryAction.kind === "view") {
      localApi.openExternal(primaryAction.url);
      requestInputFocus();
      return;
    }
    if (primaryAction.kind !== "run") return;
    void actions.run(primaryAction.action, {
      createFeatureBranch: primaryAction.createFeatureBranch,
    });
  }

  // --- Rows, in the order 5c lays them out. Commit remains a disclosure for
  //     its variants and the destructive escape hatch. Pull requests use the
  //     status-aware primary action directly. ---
  const actionDefs = $derived.by<ActionDef[]>(() => {
    const defs: ActionDef[] = [
      {
        key: "commit",
        // The row is "Commit"; publishing is a choice inside it, so the panel's
        // headline label no longer changes meaning when a push is configured.
        label:
          isCommitActionRunning && actions.activeLabel
            ? actions.activeLabel
            : actions.lastResult?.commit.status === "created"
              ? "Committed"
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
        label: isPullRequestActionRunning && actions.activeLabel
          ? actions.activeLabel
          : primaryAction.label,
        icon: GitPullRequestIcon,
        phase: prPhase,
        disabled: primaryAction.kind === "disabled" || actions.running,
        run: runPrimaryAction,
        secondaryMenu: "pull-requests",
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
        phase: "idle",
        disabled: !canViewDiff,
        run: () => {
          window.dispatchEvent(
            new CustomEvent("solus:toggle-diff-panel", {
              detail: { tabId: sourceId, scope: { kind: "working-tree" }, switchScope: true },
            }),
          );
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

  // The commit popover is anchored to its row, like the branch picker.
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
    const row = el.closest(".row-wrap");
    openRowEl = row instanceof HTMLElement ? row : null;
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

  function activateRow(
    def: ActionDef,
    event: MouseEvent & { currentTarget: HTMLButtonElement },
  ) {
    if (def.disclosure) toggleRowMenu(def.disclosure, event.currentTarget);
    else def.run();
  }

  // The PR list backs the row's current PR state. Read through the
  // store (cached) with an explicit filter rather than `loadAll`, which would
  // stomp the PRs pane's own filter state.
  let openPrs = $state<PullRequestSummary[]>([]);
  async function loadOpenPrs() {
    if (!canViewDiff || !env.cwd) return;
    const ctx = session.ctxForEnvironment(env.cwd, env.checkout, sourceId);
    try {
      openPrs = (
        await session.prsStore.loadFor(prApi, prServerId, ctx, { state: "open" })
      ).items;
    } catch {
      openPrs = [];
    }
  }

  // --- The branch's own pull request ---------------------------------------
  // `prUrl` rides along on the detailed status for free, but `gh pr view`
  // answers for closed and merged branches too — it only says "worth asking".
  // The open list is what decides whether the PR is still live, so the row
  // reports from the match and stays quiet when the branch's PR has landed.
  const activePr = $derived(
    currentBranch
      ? (openPrs.find((pr) => pr.headRef === currentBranch) ?? null)
      : null,
  );
  const activePrBadge = $derived(
    activePr
      ? activePr.draft
        ? `Draft · #${activePr.number}`
        : `#${activePr.number}`
      : undefined,
  );

  // CI state colours the glyph. `checksPresentation` is the same reading the PRs
  // page shows, so the two surfaces can't disagree — including its refusal to
  // assert a result computed against a head the branch has since moved past.
  const prChecks = $derived(
    activePr
      ? checksPresentation(
          session.prsStore.checksFor(
            prServerId,
            session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
            activePr.number,
          ),
          activePr.headSha,
          session.prsStore.checksLoadFailedFor(
            prServerId,
            session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
          ),
        )
      : null,
  );
  // Draft PRs stay untinted: nothing is being asserted about a PR that isn't
  // asking to land yet. `none`/`unavailable` are likewise not a verdict.
  const activePrTone = $derived<ActionRowItem["iconTone"]>(
    !prChecks || activePr?.draft
      ? undefined
      : prChecks.state === "failing"
        ? "danger"
        : prChecks.state === "pending"
          ? "running"
          : prChecks.state === "passing"
            ? "success"
            : undefined,
  );

  // `prUrl` gates the fetch, so a branch with no pull request never costs a host
  // round-trip. Plain `let`, not `$state`: it guards the request, and writing
  // reactive state the effect reads would re-run it.
  let requestedPrsFor: string | null = null;
  $effect(() => {
    if (!prUrl) return;
    const key = `${env.cwd}\0${currentBranch}`;
    if (requestedPrsFor === key) return;
    requestedPrsFor = key;
    void loadOpenPrs();
  });

  // The host caches checks per repo, so asking for this one PR warms — and reads
  // from — the same snapshot the PRs page uses rather than a second poll.
  let requestedChecksFor: number | null = null;
  $effect(() => {
    if (!activePr || requestedChecksFor === activePr.number) return;
    requestedChecksFor = activePr.number;
    void session.prsStore
      .loadChecks(
        prApi,
        prServerId,
        session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
        [activePr.number],
      )
      .catch(() => {});
  });

  // Only the Environment section watches detailed status, and sections unmount
  // when collapsed — without our own watch the PR row would go blank whenever
  // that section is closed.
  $effect(() => {
    if (!detailCwd || detailCwd === "~") return;
    return environmentStore.watchDetails(detailServerId, detailCwd);
  });

  // "Discard changes…" arms in place rather than opening a dialog — the menu
  // swaps to a confirm row, which is what the ellipsis promises.
  let confirmingDiscard = $state(false);

  function runDiscard() {
    closeRowMenu();
    confirmingDiscard = false;
    void actions.discard();
  }

  // The composer is an additive escape hatch beside the one-click rows above:
  // it opens on demand and unmounts on close, unlike the persistently-mounted
  // panel content the rest of this component drives.
  let commitComposerAction = $state<"commit" | "commit_push" | null>(null);

  function openCommitComposer(commitAction: "commit" | "commit_push") {
    closeRowMenu();
    commitComposerAction = commitAction;
  }

  function closeCommitComposer() {
    commitComposerAction = null;
    requestInputFocus();
  }

  function openPr(pr: PullRequestSummary) {
    closeRowMenu();
    void session.enterPrReview(pr.number, pr.title, {
      ctx: session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
      serverId: prServerId,
    });
  }

  // Review companion: run the producer (review the diff, enriched by the ledger
  // when present → fixed-structure HTML) for the current branch, then wait for
  // an explicit second click before opening the companion in the main pane.
  const reviewIdentity = $derived.by(() => {
    const identity = branchGuideIdentity(env);
    if (!identity) return null;
    const changes = status?.uncommittedChanges;
    return {
      ...identity,
      revision: [
        status?.headSha ?? "",
        ...(changes?.files.map((file) => file.path) ?? []),
        changes?.insertions ?? 0,
        changes?.deletions ?? 0,
      ].join("|"),
    };
  });
  const reviewStatus = $derived(
    reviewGuideStore.statusFor(session.apiFor(sourceId), reviewIdentity),
  );
  const reviewing = $derived(
    reviewStatus?.status === "queued" || reviewStatus?.status === "generating",
  );
  const reviewKey = $derived(
    reviewStatus?.status === "ready" ? reviewStatus.key : null,
  );
  let lastReviewFailureAt = 0;

  $effect(() => {
    const identity = reviewIdentity;
    if (!identity) return;
    void reviewGuideStore.load(
      session.apiFor(sourceId),
      session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
      identity,
      "branch",
    );
  });

  $effect(() => {
    if (
      reviewStatus?.status !== "failed" ||
      reviewStatus.updatedAt === lastReviewFailureAt
    ) return;
    lastReviewFailureAt = reviewStatus.updatedAt;
    toasts.error(
      reviewStatus.error
        ? `Review stopped: ${reviewStatus.error}`
        : "Review stopped before a report was produced. Try again.",
    );
  });

  function handleReview() {
    if (reviewKey) {
      session.enterReview(reviewKey, "branch", sourceId);
      requestInputFocus();
      return;
    }
    void generateReport();
  }

  async function generateReport() {
    if (reviewing) return;
    const identity = reviewIdentity;
    if (!identity) return;
    const ctx = session.ctxForEnvironment(env.cwd, env.checkout, sourceId);
    try {
      await reviewGuideStore.generate(
        session.apiFor(sourceId),
        ctx,
        identity,
        {
          ...resolveReviewAgent(settings, agentContext),
          scope: "branch",
        },
      );
    } catch (error) {
      toasts.error("Couldn't generate report", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestInputFocus();
    }
  }

  function regenerateReport() {
    void generateReport();
  }

  function cancelReview() {
    if (!reviewing) return;
    void reviewGuideStore.cancel(
      session.apiFor(sourceId),
      session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
      "branch",
    );
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
    class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs lg:text-xs focus-visible:outline-none focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) disabled:pointer-events-none disabled:opacity-50 {opts.danger
      ? 'font-normal text-destructive hover:bg-destructive/10 hover:text-destructive'
      : opts.emphasis
        ? 'bg-[color-mix(in_srgb,var(--solus-accent)_8%,transparent)] font-medium text-(--solus-text-primary) hover:bg-[color-mix(in_srgb,var(--solus-accent)_14%,transparent)]'
        : 'font-normal text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
  >
    <span class="min-w-0 flex-1 truncate">{label}</span>
    {#if opts.trail}
      <span
        class="shrink-0 text-menu-meta tabular-nums text-(--solus-text-tertiary)"
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

<div class="menu-list">
  {#each actionDefs as def (def.key)}
    <!-- An open PR is reported by the row that already stands for it: the
         branch's PR becomes the label, its number the trailing metric, and the
         glyph takes the colour of its checks. Nothing is added to the column,
         and the row's menu still opens from the same click. -->
    {@const item =
      def.key === "pull-requests" &&
      activePr &&
      prPhase === "idle" &&
      primaryAction.kind === "view"
        ? {
            ...def,
            label: activePr.title,
            badge: activePrBadge,
            iconTone: activePrTone,
            tooltip: prChecks
              ? `${prChecks.label} — ${prChecks.tooltip}`
              : undefined,
          }
        : def}
    <div class="row-wrap">
      {#if def.secondaryMenu}
        <div class="split-row">
          <MenuRow {item} split onActivate={() => def.run()} />
          <button
            type="button"
            class="split-caret"
            class:is-open={rowMenuOpen && openMenuKey === def.secondaryMenu}
            aria-label="More pull request actions"
            aria-haspopup="menu"
            aria-expanded={rowMenuOpen && openMenuKey === def.secondaryMenu}
            onclick={(event) => toggleRowMenu(def.secondaryMenu!, event.currentTarget)}
          >
            <CaretRightIcon size={11} />
          </button>
        </div>
      {:else if def.key === "review" && (reviewing || reviewKey)}
        <div class="split-row">
          <MenuRow {item} split onActivate={(e) => activateRow(def, e)} />
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
        <MenuRow
          {item}
          menuOpen={!!def.disclosure &&
            rowMenuOpen &&
            openMenuKey === def.disclosure}
          onActivate={(e) => activateRow(def, e)}
        />
      {/if}
    </div>
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
          class="m-0 px-2 pt-[0.3125rem] pb-[0.4375rem] text-menu-meta leading-[1.5] text-(--solus-text-tertiary)"
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
            void actions.run("commit");
          },
          emphasis: true,
          disabled: !canGit || actions.running,
        })}
        {@render popRow("Commit and push", {
          onclick: () => {
            closeRowMenu();
            void actions.run("commit_push");
          },
          hint: comboHint("orb.commit-push"),
          disabled: !canGit || actions.running,
        })}
        {@render popRow("Commit with options…", {
          onclick: () => openCommitComposer("commit"),
          disabled: !canGit || actions.running || uncommittedFileCount === 0,
        })}
        {@render popRow("Commit and push with options…", {
          onclick: () => openCommitComposer("commit_push"),
          disabled: !canGit || actions.running || uncommittedFileCount === 0,
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
            uncommittedFileCount > 0 ? String(uncommittedFileCount) : undefined,
          danger: true,
          disabled: !canGit || uncommittedFileCount === 0,
        })}
      {/if}
    {:else if openMenuKey === "pull-requests"}
      {#if openPrs.length > 0}
        {#each openPrs.slice(0, 5) as pr (pr.number)}
          {@render popRow(pr.title, {
            onclick: () => openPr(pr),
            trail: `#${pr.number}`,
          })}
        {/each}
        {@render popDivider()}
      {/if}
      {@render popRow("Review a PR…", {
        onclick: () => {
          closeRowMenu();
          window.dispatchEvent(
            new CustomEvent("solus:review-pr", {
              detail: {
                tabId: sourceId || undefined,
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

{#if commitComposerAction}
  <CommitComposer
    {sourceId}
    action={commitComposerAction}
    {session}
    {environmentStore}
    {actions}
    onClose={closeCommitComposer}
  />
{/if}

<style>
  .menu-list {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    margin-bottom: 0.5rem;
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
  .split-caret[aria-expanded="true"],
  .split-caret.is-open {
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

  /* Key hints inside the popover rows — mono and quieter than the labels. */
  .menu-hint {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-family: var(--solus-code-font-family);
    font-size: var(--text-menu-meta);
    opacity: 0.7;
  }
</style>
