<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    RefreshCw as ArrowsClockwiseIcon,
    ArrowDownToLine as GitPullIcon,
    ChevronRight as CaretRightIcon,
    CloudUpload as CloudArrowUpIcon,
    Glasses as EyeglassesIcon,
    GitCommitHorizontal as GitCommitIcon,
    GitPullRequest as GitPullRequestIcon,
    Link as LinkIcon,
    Map as MapIcon,
    FileDiff as FileDiffIcon,
    Search as MagnifyingGlassIcon,
    Send as PaperPlaneTiltIcon,
    Trash2 as TrashIcon,
    CircleAlert as WarningCircleIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import {
    getSessionEnvironmentStore,
    getWorkspaceContext,
    getPullRequestsContext,
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
  import * as Popover from "../ui/popover";
  import MenuRow, {
    type ActionRowIcon,
    type ActionRowItem,
  } from "./MenuRow.svelte";
  import { checksPresentation } from "../prs/lib/checks";
  import {
    parseGitHubPullRequestUrl,
    type PullRequest,
  } from "@solus/contracts/providers";
  import { projectScopeOf, type GitAction } from "@solus/contracts/types";
  import { serverConnections } from "@solus/client-core/server-connections";
  import {
    gitPublishModel,
    isPullRequestRunning,
    type GitMenuStep,
  } from "./lib/git-action-selection";
  import { repositorySetupStore } from "../../contexts/git/repository-setup.store.svelte";
  import CommitComposer from "./commit-composer/CommitComposer.svelte";
  import LinkedPullRequestRows from "./LinkedPullRequestRows.svelte";
  import PublishRepositoryDialog from "./publish-repository/PublishRepositoryDialog.svelte";

  interface Props {
    /** The tab or draft whose run this section describes — see `ProjectPanel`. */
    sourceId: string;
  }
  let { sourceId }: Props = $props();

  const environmentStore = getSessionEnvironmentStore();
  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const settings = getSettingsContext();
  const agentContext = getAgentContext();
  const prApi = $derived(session.apiFor(sourceId));
  const prServerId = $derived(serverConnections.serverIdForApi(prApi));
  const env = $derived(
    environmentStore.environmentFor(session.runFor(sourceId)),
  );
  const detailCwd = $derived(env.cwd);
  const detailServerId = $derived(prServerId);
  const status = $derived(env.status);
  const conflictedFiles = $derived(
    status?.uncommittedChanges.files.filter((file) => file.conflicted) ?? [],
  );
  const uncommittedFileCount = $derived(
    status?.uncommittedChanges.files.length ?? 0,
  );
  const actions = $derived(gitActionsFor(sourceId, session, environmentStore, pullRequests.projects));
  // "Discard changes…" arms in place rather than opening a dialog — the row
  // swaps to a confirm label, which is what the ellipsis promises.
  let confirmingDiscard = $state(false);
  // The armed state can't outlive the changes it would discard — a commit or an
  // agent's own cleanup can empty the working tree while the row sits armed.
  const isConfirmingDiscard = $derived(
    confirmingDiscard && uncommittedFileCount > 0,
  );

  const canGit = $derived(!!env.branch);
  const hasGitStatus = $derived(!!status);
  const prUrl = $derived(actions.prUrl || status?.prUrl || null);

  // One reading of the project's Git state backs every row and both menus, so a
  // row label and its menu can never report different states. It also carries
  // the readiness stage: a project with no remote publishes from the pull
  // request row instead of committing into nowhere.
  const model = $derived(
    gitPublishModel(status, {
      repository: repositorySetupStore.statusFor(detailServerId, env.cwd),
      githubConnected: repositorySetupStore.githubConnectedFor(
        detailServerId,
        env.cwd,
      ),
    }),
  );
  const primaryAction = $derived(model.pullRequest.primary);
  const MENU_STEP_ICON = {
    commit_with_options: GitCommitIcon,
    push: CloudArrowUpIcon,
    create_pull_request: GitPullRequestIcon,
  } satisfies Record<GitMenuStep["key"], ActionRowIcon>;
  const isCommitActionRunning = $derived(
    actions.running &&
      (actions.activeAction === "commit" ||
        actions.activeAction === "commit_push" ||
        actions.activeAction === "commit_push_pull_request"),
  );
  const isPullRequestActionRunning = $derived(
    actions.running &&
      isPullRequestRunning(actions.activeAction, actions.activePhase),
  );
  const currentBranch = $derived(
    status === undefined ? env.branch : (status?.branch ?? null),
  );

  // --- Shared action model: every row renders from one definition,
  //     so labels/icons align by construction. ---
  interface ActionDef extends ActionRowItem {
    /** Trailing caret beside the row's primary action: it either drops that
     *  row's menu, or runs one companion action of its own. */
    caretAction?: {
      ariaLabel: string;
      icon?: ActionRowIcon;
      menu?: MenuKey;
      danger?: boolean;
      disabled?: boolean;
      run?: () => void;
    };
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
      openPrUrl(primaryAction.url);
      return;
    }
    // Publishing creates the remote this row needs, and the dialog is also
    // where a missing GitHub connection is reported.
    if (primaryAction.kind === "publish" || primaryAction.kind === "connect") {
      publishDialogOpen = true;
      return;
    }
    if (primaryAction.kind !== "run") return;
    void actions.run(primaryAction.action, {
      createFeatureBranch: primaryAction.createFeatureBranch,
    });
  }

  // --- Rows, in the order 5c lays them out. The commit row owns local work and
  //     the push that carries it; the pull request row owns the remote and the
  //     pull request, including creating the remote. Each row's caret drops the
  //     by-hand version of the steps its primary action bundles. ---
  const actionDefs = $derived.by<ActionDef[]>(() => {
    const commitPrimary = model.commit.primary;
    const defs: ActionDef[] = [
      {
        key: "commit",
        label:
          isCommitActionRunning && actions.activeLabel
            ? actions.activeLabel
            : actions.lastResult?.commit.status === "created"
              ? "Committed"
              : commitPrimary.label,
        icon: PaperPlaneTiltIcon,
        // No trailing count: the changed-file total already sits on the stats
        // line under the branch, and repeating it here reads as a second,
        // different number.
        phase: commitPhase,
        hint: comboHint("orb.commit-push"),
        disabled: !canGit || actions.running || commitPrimary.kind !== "run",
        tooltip:
          commitPrimary.kind === "disabled" ? commitPrimary.reason : undefined,
        run: () => {
          if (commitPrimary.kind !== "run") return;
          void actions.run(commitPrimary.action);
        },
        caretAction: { ariaLabel: "More commit actions", menu: "commit" },
      },
      {
        key: "sync",
        label: actions.synced
          ? "Synced"
          : actions.syncing
            ? "Syncing…"
            : "Sync with remote",
        icon: GitPullIcon,
        phase: actions.syncing
          ? "loading"
          : actions.synced
            ? "success"
            : actions.syncError
              ? "error"
              : "idle",
        hint: comboHint("orb.sync"),
        disabled: !canGit || actions.syncing || model.sync.disabled,
        tooltip: model.sync.reason,
        run: () => {
          void actions.sync();
        },
      },
      {
        key: "pull-requests",
        label:
          isPullRequestActionRunning && actions.activeLabel
            ? actions.activeLabel
            : primaryAction.label,
        icon: GitPullRequestIcon,
        phase: prPhase,
        disabled: primaryAction.kind === "disabled" || actions.running,
        tooltip:
          primaryAction.kind === "disabled" ? primaryAction.reason : undefined,
        run: runPrimaryAction,
        caretAction: {
          ariaLabel: "More pull request actions",
          menu: "pull-requests",
        },
      },
      {
        key: "review",
        label: reviewing
          ? reviewKey
            ? "Regenerating review guide…"
            : "Generating review guide…"
          : "Review changes",
        icon: EyeglassesIcon,
        phase: reviewing ? "loading" : reviewKey ? "success" : "idle",
        disabled: !canGit,
        run: () => {
          void handleReview();
        },
        caretAction: {
          ariaLabel: "Review options",
          menu: "review",
        },
      },
    ];
    // Discard arms in place: the row itself becomes the confirmation, so the
    // irreversible action still needs a second, deliberate click, and the caret
    // beside it is the way back out.
    defs.push({
      key: "discard",
      danger: true,
      label: isConfirmingDiscard
        ? `Discard ${uncommittedFileCount} change${uncommittedFileCount === 1 ? "" : "s"}?`
        : "Discard changes…",
      icon: TrashIcon,
      phase: actions.discarding ? "loading" : "idle",
      badge:
        !isConfirmingDiscard && uncommittedFileCount > 0
          ? String(uncommittedFileCount)
          : undefined,
      disabled: !canGit || uncommittedFileCount === 0 || actions.discarding,
      run: () => {
        if (isConfirmingDiscard) runDiscard();
        else confirmingDiscard = true;
      },
      caretAction: isConfirmingDiscard
        ? {
            ariaLabel: "Keep changes",
            icon: XIcon,
            run: () => (confirmingDiscard = false),
          }
        : undefined,
    });
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

  // A row's menu is anchored to that row, like the branch picker.
  type MenuKey = "commit" | "pull-requests" | "review";
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
    rowMenuOpen = true;
    if (key === "pull-requests") void loadOpenPrs();
  }

  function closeRowMenu() {
    rowMenuOpen = false;
    requestInputFocus();
  }

  // The PR list backs the row's current PR state. Read through the
  // store (cached) with an explicit filter rather than `loadAll`, which would
  // stomp the PRs pane's own filter state.
  // The rows read the store's own answer for this project rather than keeping a
  // copy: the same facts the PRs page, the task rail and the session sidebar
  // name, so none of these surfaces can disagree about a pull request.
  const prProjectScope = $derived(
    env.cwd
      ? projectScopeOf(
          session.ctxForEnvironment(env.cwd, env.checkout, sourceId).session,
        )
      : null,
  );
  const openPrs = $derived(
    pullRequests.projects.at(prServerId, prProjectScope)?.openPrs ?? [],
  );
  async function loadOpenPrs() {
    if (!hasGitStatus || !env.cwd) return;
    const ctx = session.ctxForEnvironment(env.cwd, env.checkout, sourceId);
    // Reading the list is what fills the store's lookups; the rows above are
    // derived from those, so nothing here has to hold the response.
    await pullRequests.projects
      .get(prApi, prServerId, ctx)
      .query({ state: "open" })
      .catch(() => null);
  }

  // --- The branch's own pull request ---------------------------------------
  // `prUrl` rides along on the detailed status for free, but `gh pr view`
  // answers for closed and merged branches too — it only says "worth asking".
  // The store's branch index is what decides whether the PR is still live, so
  // the row reports from the match and stays quiet when the branch's PR landed.
  const activePr = $derived.by(() => {
    const pr = pullRequests.projects.at(prServerId, prProjectScope)?.prForBranch(
      currentBranch,
    );
    return pr?.state === "open" ? pr : null;
  });
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
          pullRequests.checks.summaryFor(
            prServerId,
            session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
            activePr.number,
          ),
          activePr.headSha,
          pullRequests.checks.loadFailedFor(
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
    void pullRequests.checks
      .load(
        prApi,
        prServerId,
        session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
        [activePr.number],
      )
      .catch(() => {});
  });

  // The readiness stage decides what every row means, so the rows read the
  // repository probe themselves rather than depending on the setup card being
  // mounted beside them. The store de-duplicates the request either way.
  let requestedSetupFor: string | null = null;
  $effect(() => {
    if (!env.cwd || env.cwd === "~" || !prApi) return;
    const key = `${detailServerId}\0${env.cwd}`;
    if (requestedSetupFor === key) return;
    requestedSetupFor = key;
    void repositorySetupStore.refresh(prApi, detailServerId, env.cwd);
  });

  // Only the publish path needs the GitHub connection, so an already-published
  // project never pays for the probe.
  let requestedConnectionFor: string | null = null;
  $effect(() => {
    if (model.readiness !== "local-only" || !prApi) return;
    const key = `${detailServerId}\0${env.cwd}`;
    if (requestedConnectionFor === key) return;
    requestedConnectionFor = key;
    void repositorySetupStore.refreshGithubConnection(
      prApi,
      detailServerId,
      session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
      env.cwd,
    );
  });

  // Only the Environment section watches detailed status, and sections unmount
  // when collapsed — without our own watch the PR row would go blank whenever
  // that section is closed.
  $effect(() => {
    if (!detailCwd || detailCwd === "~") return;
    return environmentStore.watchDetails(detailServerId, detailCwd);
  });

  function runDiscard() {
    confirmingDiscard = false;
    void actions.discard();
    requestInputFocus();
  }

  // The composer is the "with options" half of the commit row: it opens on
  // demand and unmounts on close, unlike the persistently-mounted panel content
  // the rest of this component drives.
  let commitComposerOpen = $state(false);
  // The composer commits as far as the row does: to the remote once there is
  // one, locally while the project is still unpublished.
  let composerAction =
    $state<Extract<GitAction, "commit" | "commit_push">>("commit_push");

  function openCommitComposer(step: GitMenuStep) {
    if (step.action === "commit" || step.action === "commit_push")
      composerAction = step.action;
    commitComposerOpen = true;
  }

  function closeCommitComposer() {
    commitComposerOpen = false;
    requestInputFocus();
  }

  let publishDialogOpen = $state(false);

  function closePublishDialog() {
    publishDialogOpen = false;
    requestInputFocus();
  }

  async function copyPrLink(url: string) {
    try {
      if (navigator.clipboard?.writeText)
        await navigator.clipboard.writeText(url);
      toasts.success("Copied pull request link");
    } catch {
      toasts.error("Couldn't copy the link");
    }
    requestInputFocus();
  }

  function openPr(pr: PullRequest) {
    closeRowMenu();
    void session.openPullRequest(pr, {
      ctx: session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
      serverId: prServerId,
      target: "aside",
    });
  }

  function openPrUrl(url: string) {
    const parsed = parseGitHubPullRequestUrl(url);
    if (!parsed) {
      void localApi.openExternal(url);
      return;
    }
    void session.openPullRequest(
      {
        number: parsed.number,
        url: parsed.url,
        expectedRepo: parsed.baseRepo,
      },
      {
        ctx: session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
        serverId: prServerId,
        target: "aside",
        via: "click",
      },
    );
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
    reviewGuideStore.statusFor(session.serverIdFor(sourceId), reviewIdentity),
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
      session.serverIdFor(sourceId),
      session.ctxForEnvironment(env.cwd, env.checkout, sourceId),
      identity,
      "branch",
    );
  });

  $effect(() => {
    if (
      reviewStatus?.status !== "failed" ||
      reviewStatus.updatedAt === lastReviewFailureAt
    )
      return;
    lastReviewFailureAt = reviewStatus.updatedAt;
    toasts.error(
      reviewStatus.error
        ? `Review stopped: ${reviewStatus.error}`
        : "Review stopped before a report was produced. Try again.",
    );
  });

  // The diff is the default reading surface. Once a guide exists, the same
  // primary action resumes that guide instead of making the user find it.
  function handleReview() {
    if (reviewKey) session.openReviewGuide({ kind: "branch" }, sourceId);
    else session.enterReview("branch", sourceId, "diff");
    requestInputFocus();
  }

  function openReviewView(view: "map" | "diff") {
    closeRowMenu();
    session.enterReview("branch", sourceId, view);
  }

  async function generateReport() {
    if (reviewing) return;
    const identity = reviewIdentity;
    if (!identity) return;
    const ctx = session.ctxForEnvironment(env.cwd, env.checkout, sourceId);
    toasts.info("Started generating the review guide");
    try {
      await reviewGuideStore.generate(
        session.apiFor(sourceId),
        session.serverIdFor(sourceId),
        ctx,
        identity,
        { ...resolveReviewAgent(settings), scope: "branch" },
      );
    } catch (error) {
      toasts.error("Couldn't generate the review guide", {
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
    trail?: string;
    icon?: ActionRowIcon;
    /** Kept clickable-looking but inert: `aria-disabled` still shows `title`,
     *  which is where the step's reason lives. */
    disabled?: boolean;
    title?: string;
  },
)}
  <button
    type="button"
    aria-disabled={opts.disabled || undefined}
    title={opts.title}
    onclick={() => {
      if (!opts.disabled) opts.onclick();
    }}
    class="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs lg:text-xs font-normal focus-visible:outline-none focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) {opts.disabled
      ? 'cursor-default text-(--solus-text-tertiary) opacity-60'
      : 'text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)'}"
  >
    {#if opts.icon}
      {@const RowIcon = opts.icon}
      <span class="flex shrink-0 items-center"><RowIcon size={13} /></span>
    {/if}
    <span class="min-w-0 flex-1 truncate">{label}</span>
    {#if opts.trail}
      <span class="shrink-0 text-xs tabular-nums text-(--solus-text-tertiary)"
        >{opts.trail}</span
      >
    {/if}
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
      {#if def.caretAction}
        {@const caret = def.caretAction}
        {@const CaretIcon = caret.icon ?? CaretRightIcon}
        {@const menuOpen =
          !!caret.menu && rowMenuOpen && openMenuKey === caret.menu}
        <div class="split-row">
          <MenuRow {item} split onActivate={() => def.run()} />
          <button
            type="button"
            class="split-caret"
            class:is-open={menuOpen}
            class:is-danger={caret.danger}
            aria-label={caret.ariaLabel}
            title={caret.ariaLabel}
            aria-haspopup={caret.menu ? "menu" : undefined}
            aria-expanded={caret.menu ? menuOpen : undefined}
            disabled={caret.disabled}
            onclick={(event) => {
              if (caret.menu) toggleRowMenu(caret.menu, event.currentTarget);
              else caret.run?.();
            }}
          >
            <CaretIcon size={11} />
          </button>
        </div>
      {:else}
        <MenuRow {item} onActivate={() => def.run()} />
      {/if}
    </div>
  {/each}
  <!-- Once the branch has a pull request, the column continues past the Git
       rows: a divider, then what to do with the pull request itself. -->
  {#if activePr}
    <LinkedPullRequestRows
      pr={activePr}
      ctx={session.ctxForEnvironment(env.cwd, env.checkout, sourceId)}
      serverId={prServerId}
      api={prApi}
      checks={prChecks}
      onMerged={() => void loadOpenPrs()}
    />
  {/if}
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
      {#each model.commit.steps as step (step.key)}
        {@render popRow(step.label, {
          icon: MENU_STEP_ICON[step.key],
          onclick: () => {
            closeRowMenu();
            // "Commit…" is the with-options half of the row: it opens the
            // composer rather than running straight away.
            if (step.key === "commit_with_options") openCommitComposer(step);
            else void actions.run(step.action);
          },
          disabled: step.disabled || !canGit || actions.running,
          title: step.reason,
        })}
      {/each}
    {:else if openMenuKey === "pull-requests"}
      <!-- This branch's pull request: the steps its primary action bundles,
           then the ways to reach the pull request it already has. -->
      {#each model.pullRequest.steps as step (step.key)}
        {@render popRow(step.label, {
          icon: MENU_STEP_ICON[step.key],
          onclick: () => {
            closeRowMenu();
            void actions.run(step.action);
          },
          disabled: step.disabled || !canGit || actions.running,
          title: step.reason,
        })}
      {/each}
      {#if prUrl}
        {@render popRow("Copy link", {
          icon: LinkIcon,
          onclick: () => {
            closeRowMenu();
            void copyPrLink(prUrl);
          },
        })}
        {@render popDivider()}
      {/if}
      {#if openPrs.length > 0}
        {#each openPrs.slice(0, 5) as pr (pr.number)}
          <!-- The list entries carry the glyph too: without it their labels
               would sit in a different column from every row around them. -->
          {@render popRow(pr.title, {
            icon: GitPullRequestIcon,
            onclick: () => openPr(pr),
            trail: `#${pr.number}`,
          })}
        {/each}
        {@render popDivider()}
      {/if}
      {@render popRow("Review a PR…", {
        icon: MagnifyingGlassIcon,
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
    {:else if openMenuKey === "review"}
      {@render popRow("Open map", {
        icon: MapIcon,
        onclick: () => openReviewView("map"),
      })}
      {@render popRow(
        reviewing
          ? "Cancel guide generation"
          : reviewKey
            ? "Regenerate guide"
            : "Generate review guide",
        {
          icon: reviewing ? XIcon : ArrowsClockwiseIcon,
          onclick: () => {
            closeRowMenu();
            if (reviewing) cancelReview();
            else regenerateReport();
          },
        },
      )}
      {@render popRow("Open diff", {
        icon: FileDiffIcon,
        onclick: () => openReviewView("diff"),
      })}
    {/if}
  </Popover.Content>
</Popover.Root>

{#if commitComposerOpen}
  <CommitComposer
    {sourceId}
    action={composerAction}
    {session}
    {environmentStore}
    {actions}
    onClose={closeCommitComposer}
  />
{/if}

{#if publishDialogOpen}
  <PublishRepositoryDialog {sourceId} onClose={closePublishDialog} />
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
  .split-caret:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .split-caret:disabled:hover {
    background: transparent;
    color: var(--solus-text-tertiary);
  }
</style>
