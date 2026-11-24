<script lang="ts">
  import {
    ArrowUpRight as ArrowUpRightIcon,
    ChevronDown as CaretDownIcon,
    Eye as EyeIcon,
    EyeOff as EyeOffIcon,
    FileDiff as FileDiffIcon,
    GitBranch as GitBranchIcon,
    Glasses as EyeglassesIcon,
    Globe as GlobeIcon,
    History as HistoryIcon,
    Link as LinkIcon,
    LoaderCircle as SpinnerIcon,
    PanelRight as PanelRightIcon,
    RefreshCw as RefreshIcon,
  } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import { localApi } from "@solus/client-core/local-api";
  import type { PullRequest } from "@solus/contracts/providers";
  import type { SessionPullRequestLink } from "@solus/contracts/session-pull-requests";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { sessionPullRequestsStore } from "../../contexts/prs/session-pull-requests.store.svelte";
  import { canDriveSession } from "../../contexts/sharing/resource-roles";
  import { notificationsStore } from "../../contexts/notifications/notifications.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { copyText, toasts } from "../../lib/toasts";
  import { isFailing, orderedChecks, type ChecksPresentation } from "../prs/lib/checks";
  import { armedAutoMergeLabel, mergeReadiness } from "../pr-review/lib/merge-readiness";
  import { prStatusGlyph, prStatusOf } from "../prs/lib/prs-list-view";
  import { buildPrChecksFixPrompt } from "../pr-review/lib/pr-input-drafts";
  import { nextMoveLabel, nextMoveOpensDraft } from "./lib/linked-pull-request-row";
  import { watchRefusal } from "../conversation/lib/pull-request-card";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import * as TooltipUI from "../ui/tooltip";
  import { PANEL_ROW_ICON_SIZE } from "./MenuRow.svelte";
  import PullRequestChecksButton from "./PullRequestChecksButton.svelte";

  // The session's pull request as one row of two lines (docs/project-panel.md):
  // the title, which opens it, with a menu beside it; then its number, its
  // checks, the watch, and the one next move. Everything else about it is in
  // the title's details card, the checks popover, or the menu.
  interface Props {
    pr: PullRequest;
    ctx: IpcContext;
    serverId: string;
    api: HostApi;
    /** The same checks reading the other pull request rows tint their glyph with. */
    checks: ChecksPresentation | null;
    /** The owning tab and project panel are visible. */
    active: boolean;
    /** `owner/repo` when the pull request is not in this checkout's
     *  repository; null when it is. */
    otherRepository?: string | null;
    /** The session's link to this pull request while the session watches it;
     *  null when nothing watches it. */
    watchedLink?: SessionPullRequestLink | null;
    /** The pull request left this branch's open set — the rail must re-read it. */
    onMerged: () => void;
    /** Open a new session draft for this branch with the prompt filled in —
     *  the rail's way of handing a blocker to an agent. */
    onAgentDraft: (prompt: string) => void;
  }
  let {
    pr,
    ctx,
    serverId,
    api,
    checks,
    active,
    otherRepository = null,
    watchedLink = null,
    onMerged,
    onAgentDraft,
  }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();

  // The detail answers what the viewer may do, so nothing is offered that the
  // host would refuse.
  // Read from the store's own index rather than kept here: a merge landing on
  // any other surface reaches this row, because the store indexes every detail
  // it sees and this is a reactive read of that index.
  const detail = $derived(
    pullRequests.projects.at(serverId, projectScopeOf(ctx.session))?.prFor(pr.number) ?? null,
  );
  let merging = $state(false);
  let refreshingBeforeMerge = $state(false);
  let merged = $state(false);

  // Depend on primitive identity, so updating the shared PR entry does not
  // reinstall its interest unless the target or revision changed.
  const prNumber = $derived(pr.number);
  const prHeadSha = $derived(pr.headSha);
  const prServerId = $derived(serverId);
  const prProjectScope = $derived(projectScopeOf(ctx.session));

  $effect(() => {
    const number = prNumber;
    void prHeadSha; // A push is a new revision to probe.
    const targetServerId = prServerId;
    const targetProjectScope = prProjectScope;
    const isActive = active;
    merged = false;
    return untrack(() => {
      if (
        serverId !== targetServerId ||
        projectScopeOf(ctx.session) !== targetProjectScope
      )
        return;
      if (!isActive) return;
      void pullRequests.guides
        .loadMetadata(api, targetServerId, ctx, [{ number }])
        .catch(() => {});
      // Merge controls need the host-computed fields only a detail read
      // carries; PR sync keeps the rest fresh while the row is shown.
      void pullRequests.projects.get(api, targetServerId, ctx).get(number).loadDetail().catch(() => {});
      return pullRequests.projects.want(api, targetServerId, ctx, [{ kind: "pull-request", number }]);
    });
  });

  const guideStatus = $derived(
    pullRequests.guides.statusFor(serverId, ctx, pr.number),
  );
  const guideMetadata = $derived(
    pullRequests.guides.metadataFor(serverId, ctx, pr.number),
  );
  // A guide written against an earlier head is still a guide: the row opens it
  // and says it is outdated, rather than silently generating a second one.
  const hasGuide = $derived(guideStatus === "ready" || !!guideMetadata);
  const guideRunning = $derived(
    guideStatus === "queued" || guideStatus === "generating",
  );
  // The rail reads what the host's detail and the checks snapshot say; it has
  // not read the threads, so it passes no thread count and the model does not
  // guess one. The same snapshot feeds the pre-merge recheck below.
  const checksSummary = $derived(
    pullRequests.checks.summaryFor(serverId, ctx, pr.number),
  );
  const checksLoadFailed = $derived(
    pullRequests.checks.loadFailedFor(serverId, ctx),
  );
  function readinessOf(target: PullRequest) {
    return mergeReadiness({
      detail: target,
      checks: checksSummary,
      checksLoadFailed,
    });
  }
  const readiness = $derived(detail ? readinessOf(detail) : null);
  // Fixing checks and resolving conflicts hand the pull request to an agent in
  // a checkout of its repository. A pull request of another repository has no
  // checkout here, so its blocker is reported, not offered as a move.
  const handoffNeedsCheckout = $derived(
    !!otherRepository &&
      (readiness?.action?.kind === "fix-checks" ||
        readiness?.action?.kind === "resolve-conflicts"),
  );
  const primary = $derived(handoffNeedsCheckout ? null : (readiness?.action ?? null));
  const blockerNote = $derived(
    handoffNeedsCheckout
      ? `Open a checkout of ${otherRepository} to hand this to an agent.`
      : readiness?.note || undefined,
  );
  // Said in place of the blocker's headline: the host is already waiting on it.
  const armedLabel = $derived(detail ? armedAutoMergeLabel(detail) : null);

  /** Open the pull request pane on one tab: the guide, or the activity where
   *  the checks are. */
  function openPr(tab: "activity" | "guide") {
    void session.prReview.openPullRequest(pr, { ctx, serverId, tab });
    requestInputFocus();
  }

  // The title opens the pull request pane here; the caret beside it drops the
  // other ways to open it and the review guide.
  let menuOpen = $state(false);
  let titleRowEl = $state<HTMLElement | null>(null);
  let caretEl = $state<HTMLButtonElement | null>(null);

  function openInSolus() {
    menuOpen = false;
    void session.prReview.openPullRequest(pr, { ctx, serverId, via: "click" });
    requestInputFocus();
  }

  function openInBrowser() {
    menuOpen = false;
    void localApi.openExternal(pr.url);
    requestInputFocus();
  }

  function copyLink() {
    menuOpen = false;
    void copyText(pr.url).then(() => toasts.success("Link copied"));
    requestInputFocus();
  }

  // A watch the agent runs on this pull request (docs/plans/pr-watch.md). The
  // row shows while it runs; a viewer who may not change it sees it disabled.
  const canStopWatch = $derived(
    !!watchedLink && canDriveSession(serverId, watchedLink.sessionId, "edit"),
  );
  let stoppingWatch = $state(false);

  async function stopWatch() {
    if (!watchedLink || stoppingWatch) return;
    stoppingWatch = true;
    try {
      const refusal = watchRefusal(
        await sessionPullRequestsStore.setWatch(serverId, watchedLink, false),
      );
      if (refusal)
        toasts.error("Couldn't stop watching the pull request", {
          description: refusal,
        });
    } catch (error) {
      toasts.error("Couldn't stop watching the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      stoppingWatch = false;
      requestInputFocus();
    }
  }

  // The row is a producer as well as a door: with no guide yet, the click starts
  // one and the pane opens by itself the moment it is readable. Generation runs
  // on the host, so the rail can be closed — or the branch's PR replaced —
  // before it lands, and neither may steer the panes.
  let requestingGuide = $state(false);
  let mounted = true;
  onDestroy(() => (mounted = false));

  async function generateGuide() {
    if (requestingGuide || guideRunning) return;
    const number = pr.number;
    requestingGuide = true;
    toasts.info(`Started generating the review guide for PR #${number}`);
    try {
      await pullRequests.guides.request(api, serverId, ctx, [number], {
        onSettled: ({ failed }) => {
          if (failed > 0) {
            toasts.error(
              `Couldn't generate the review guide for PR #${number}`,
            );
            return;
          }
          if (mounted && pr.number === number) {
            openPr("guide");
            return;
          }
          if (!notificationsStore.wants("review_guide_ready")) return;
          toasts.success(`Review guide ready for PR #${number}`, {
            action: {
              label: "View",
              onAction: () =>
                void session.prReview.openPullRequest(
                  { number },
                  {
                    ctx,
                    serverId,
                    tab: "guide",
                  },
                ),
            },
          });
        },
      });
    } catch (error) {
      toasts.error("Couldn't start the review guide", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestingGuide = false;
      requestInputFocus();
    }
  }

  async function merge(method: Parameters<HostApi["prMerge"]>[2]) {
    if (merging || merged || !detail) return;
    // Keep stable values across the await. A successful refresh or merge can
    // remove this row before the rest of this function finishes.
    const number = pr.number;
    const expectedHeadSha = detail.headSha;
    const project = pullRequests.projects.get(api, serverId, ctx);
    const pullRequest = project.get(number);
    merging = true;
    refreshingBeforeMerge = true;
    try {
      const refreshed = await pullRequest.refreshDetail();
      refreshingBeforeMerge = false;
      if (refreshed.headSha !== expectedHeadSha) {
        toasts.info("Pull request updated", {
          description: "Review the latest changes before you merge.",
        });
        return;
      }
      const refreshedPrimary = readinessOf(refreshed).action;
      if (
        refreshedPrimary?.kind !== "merge" ||
        refreshedPrimary.method !== method
      ) {
        toasts.info("Pull request status updated", {
          description: "Review its current merge state before you continue.",
        });
        return;
      }
      await pullRequest.merge(method);
      merged = true;
      toasts.success(`Merged #${number}`);
      onMerged();
    } catch (error) {
      toasts.error("Couldn't merge the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshingBeforeMerge = false;
      merging = false;
      requestInputFocus();
    }
  }

  async function markReady() {
    if (!detail || merging) return;
    merging = true;
    try {
      // The store applies the returned detail to its own index, which is what
      // `detail` above reads — so there is nothing to assign here.
      await pullRequests.projects
        .get(api, serverId, ctx)
        .get(pr.number)
        .updateLifecycle("ready", detail.headSha);
    } catch (error) {
      toasts.error("Couldn't update the pull request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      merging = false;
      requestInputFocus();
    }
  }

  async function enableAutoMerge(method: Parameters<HostApi["prMerge"]>[2]) {
    if (!detail || merging) return;
    merging = true;
    try {
      // The store shows the armed state at once and takes it back on refusal.
      await pullRequests.projects
        .get(api, serverId, ctx)
        .get(pr.number)
        .enableAutoMerge(method);
    } catch (error) {
      toasts.error("Couldn't turn on auto-merge", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      merging = false;
      requestInputFocus();
    }
  }

  async function updateBranch() {
    if (merging) return;
    merging = true;
    try {
      await pullRequests.projects.get(api, serverId, ctx).get(pr.number).updateBranch();
    } catch (error) {
      toasts.error("Couldn't update the branch", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      merging = false;
      requestInputFocus();
    }
  }

  function resolveConflicts() {
    void session.prReview.startConflictResolverSession(
      { number: pr.number, title: pr.title },
      { ctx },
    );
    requestInputFocus();
  }


  // --- The second line -------------------------------------------------------
  const status = $derived(prStatusGlyph(prStatusOf(pr)));
  const StatusIcon = $derived(status.icon);

  // The next move, as one short verb. It is absent while the next step is
  // someone else's: a reviewer, the host, or CI.
  const moveLabel = $derived(
    merged
      ? "Merged"
      : refreshingBeforeMerge
        ? "Updating…"
        : merging
          ? "Working…"
          : primary
            ? nextMoveLabel(primary.kind)
            : null,
  );
  const moveTooltip = $derived(
    refreshingBeforeMerge
      ? "Checking the latest code-host state before merging."
      : [primary?.label, blockerNote].filter(Boolean).join(". ") || undefined,
  );

  function runNextMove() {
    if (!primary || merging || merged) return;
    if (primary.kind === "merge") void merge(primary.method);
    else if (primary.kind === "enable-auto-merge") void enableAutoMerge(primary.method);
    else if (primary.kind === "mark-ready") void markReady();
    else if (primary.kind === "resolve-conflicts") resolveConflicts();
    else if (primary.kind === "fix-checks")
      onAgentDraft(buildPrChecksFixPrompt(pr, orderedChecks(checksSummary).filter(isFailing)));
    else if (primary.kind === "update-branch") void updateBranch();
  }

  function openReviewGuide() {
    menuOpen = false;
    if (hasGuide || guideRunning) openPr("guide");
    else void generateGuide();
  }

  function regenerateReviewGuide() {
    menuOpen = false;
    void generateGuide();
  }
</script>

<!-- Line one: the status glyph and the title, which opens the pull request.
     Pointing at it shows what the row has no room for. -->
<div bind:this={titleRowEl} class="flex items-stretch gap-px">
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props: tooltipProps })}
        <button
          {...tooltipProps}
          type="button"
          class="flex min-h-[1.875rem] min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden rounded-[0.4375rem] border-none bg-transparent px-2 py-1 text-left text-(--solus-text-primary) transition-colors duration-150 hover:bg-(--solus-surface-hover) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none"
          aria-label={`Open pull request #${pr.number}, ${pr.title}`}
          onclick={openInSolus}
        >
          <span class="inline-flex shrink-0 {status.toneClass}"><StatusIcon size={PANEL_ROW_ICON_SIZE} /></span>
          <span class="min-w-0 flex-1 truncate">{pr.title}</span>
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content side="left" align="start" class="max-w-80 flex-col items-stretch gap-1.5 px-2.5 py-2 text-left font-normal">
      <div class="flex min-w-0 items-baseline gap-1.5">
        <span class="min-w-0 truncate font-medium">{pr.title}</span>
        <span class="shrink-0 text-(--solus-text-tertiary)">#{pr.number}</span>
      </div>
      <div class="flex min-w-0 items-center gap-2 text-(--solus-text-secondary)">
        <span class="inline-flex shrink-0 {status.toneClass}"><StatusIcon size={12} /></span>
        <span class="min-w-0 truncate">{readiness?.headline ?? status.label}</span>
      </div>
      <div class="flex min-w-0 items-center gap-2 text-(--solus-text-secondary)">
        <GitBranchIcon size={12} class="shrink-0" />
        <span class="min-w-0 truncate">{pr.baseRef} ← {pr.headRef}</span>
      </div>
      {#if otherRepository}
        <div class="flex min-w-0 items-center gap-2 text-(--solus-text-secondary)">
          <GlobeIcon size={12} class="shrink-0" />
          <span class="min-w-0 truncate">{otherRepository}</span>
        </div>
      {/if}
      <div class="flex min-w-0 items-center gap-2 text-(--solus-text-secondary)">
        <FileDiffIcon size={12} class="shrink-0" />
        <span class="min-w-0 truncate tabular-nums"
          >{#if pr.changedFiles !== null}{pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          {/if}<span class="text-(--solus-diff-added-text-vivid)">+{pr.additions}</span>
          <span class="text-(--solus-diff-removed-text-vivid)">−{pr.deletions}</span></span
        >
      </div>
      {#if armedLabel}
        <div class="min-w-0 text-(--solus-text-secondary)">{armedLabel}</div>
      {:else if blockerNote}
        <div class="min-w-0 text-pretty text-(--solus-text-secondary)">{blockerNote}</div>
      {/if}
    </TooltipUI.Content>
  </TooltipUI.Root>
  <button
    bind:this={caretEl}
    type="button"
    class="inline-flex w-[1.625rem] shrink-0 cursor-pointer items-center justify-center rounded-[0.4375rem] border-none bg-transparent text-(--solus-text-tertiary) transition-colors duration-150 ease-[ease] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)] focus-visible:outline-none aria-expanded:bg-(--solus-surface-hover) aria-expanded:text-(--solus-text-primary)"
    aria-label="More pull request actions"
    title="More pull request actions"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={() => (menuOpen = !menuOpen)}
  >
    <CaretDownIcon size={11} />
  </button>
</div>

<!-- Line two: the facts on the left, the controls on the right. -->
<div class="flex h-6 min-w-0 items-center gap-0.5 pr-0.5 pl-8 text-chrome-dense text-(--solus-text-tertiary)">
  <span class="mr-0.5 shrink-0 tabular-nums">#{pr.number}</span>
  {#if checks && checks.state !== "none"}
    <PullRequestChecksButton {checks} summary={checksSummary} onOpenChecks={() => openPr("activity")} />
  {/if}
  {#if watchedLink}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button
            {...tooltipProps}
            type="button"
            class="group/watch inline-flex h-[1.375rem] shrink-0 cursor-pointer items-center rounded-md border-none bg-transparent px-1.5 text-(--solus-text-secondary) transition-colors hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
            aria-label={`Stop watching #${pr.number}`}
            disabled={!canStopWatch || stoppingWatch}
            onclick={() => void stopWatch()}
          >
            {#if stoppingWatch}
              <SpinnerIcon size={14} class="motion-safe:animate-spin" />
            {:else}
              <EyeIcon size={14} class={canStopWatch ? "group-hover/watch:hidden" : ""} />
              {#if canStopWatch}<EyeOffIcon size={14} class="hidden group-hover/watch:block" />{/if}
            {/if}
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content
        value={canStopWatch
          ? "Watching: the agent wakes when checks fail or a reviewer comments. Click to stop."
          : "Watching. You can't change this session's watches."}
      />
    </TooltipUI.Root>
  {/if}
  <span class="flex-1"></span>
  {#if moveLabel}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button
            {...tooltipProps}
            type="button"
            class="inline-flex h-[1.375rem] shrink-0 cursor-pointer items-center gap-1 rounded-md border-none bg-transparent px-1.5 font-medium transition-colors hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-default {merged
              ? 'text-(--review)'
              : primary && nextMoveOpensDraft(primary.kind)
                ? 'text-(--solus-status-error)'
                : 'text-(--solus-status-complete)'}"
            disabled={!primary || merging || merged}
            onclick={runNextMove}
          >
            {moveLabel}
            {#if primary && nextMoveOpensDraft(primary.kind) && !merging}<ArrowUpRightIcon size={12} />{/if}
          </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={moveTooltip} />
    </TooltipUI.Root>
  {/if}
</div>

<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Content
    customAnchor={titleRowEl}
    side="bottom"
    align="end"
    sideOffset={4}
    collisionPadding={8}
    onInteractOutside={(event) => {
      // The caret is the menu's trigger — let its click toggle the menu rather
      // than closing here and immediately reopening.
      if (caretEl?.contains(event.target as Node | null)) event.preventDefault();
    }}
    onCloseAutoFocus={(event) => {
      // No bits-ui trigger to return to; the prompt is the next natural stop.
      event.preventDefault();
      requestInputFocus();
    }}
  >
    <DropdownMenu.Item onSelect={openInSolus}>
      <PanelRightIcon />
      <span class="min-w-0 flex-1 truncate">Open in Solus</span>
    </DropdownMenu.Item>
    <DropdownMenu.Item disabled={!pr.url} onSelect={openInBrowser}>
      <GlobeIcon />
      <span class="min-w-0 flex-1 truncate">Open in browser</span>
    </DropdownMenu.Item>
    <DropdownMenu.Item disabled={!pr.url} onSelect={copyLink}>
      <LinkIcon />
      <span class="min-w-0 flex-1 truncate">Copy link</span>
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item disabled={requestingGuide} onSelect={openReviewGuide}>
      <EyeglassesIcon />
      <span class="min-w-0 flex-1 truncate"
        >{guideRunning || requestingGuide
          ? "Generating review guide…"
          : hasGuide
            ? "Review guide"
            : "Generate review guide"}</span
      >
      {#if guideMetadata && !guideMetadata.current}
        <span class="inline-flex text-(--solus-status-running)" title="Written for an earlier commit."
          ><HistoryIcon /></span
        >
      {/if}
    </DropdownMenu.Item>
    {#if hasGuide && !guideRunning}
      <DropdownMenu.Item disabled={requestingGuide} onSelect={regenerateReviewGuide}>
        <RefreshIcon />
        <span class="min-w-0 flex-1 truncate">Regenerate review guide</span>
      </DropdownMenu.Item>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
