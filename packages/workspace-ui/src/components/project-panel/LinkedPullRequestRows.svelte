<script lang="ts">
  import {
    ArrowDownToLine as GitPullIcon,
    CircleCheck as ChecksIcon,
    CircleAlert as WarningCircleIcon,
    GitMerge as GitMergeIcon,
    GitPullRequest as GitPullRequestIcon,
    Glasses as EyeglassesIcon,
    Hammer as HammerIcon,
  } from "@lucide/svelte";
  import { onDestroy, untrack } from "svelte";
  import type { HostApi } from "@solus/client-core/host-api";
  import type { PullRequest } from "@solus/contracts/providers";
  import { projectScopeOf, type IpcContext } from "@solus/contracts/types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../contexts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import {
    isFailing,
    orderedChecks,
    type ChecksPresentation,
  } from "../prs/lib/checks";
  import {
    mergeReadiness,
    type MergeAction,
  } from "../pr-review/lib/merge-readiness";
  import {
    buildPrChecksFixPrompt,
    buildPrUpdateBranchPrompt,
  } from "../pr-review/lib/pr-input-drafts";
  import MenuRow, {
    type ActionRowIcon,
    type ActionRowItem,
  } from "./MenuRow.svelte";

  const DETAIL_REFRESH_INTERVAL_MS = 30_000;
  const FOCUS_REFRESH_AGE_MS = 15_000;
  const ACTION_ICON = {
    merge: GitMergeIcon,
    "mark-ready": GitPullRequestIcon,
    "resolve-conflicts": WarningCircleIcon,
    "fix-checks": HammerIcon,
    "update-branch": GitPullIcon,
  } satisfies Record<MergeAction["kind"], ActionRowIcon>;

  // The branch's pull request, continued in the same column: the rows above end
  // at "you have a pull request", these say what to do with it. The first row is
  // the way into the pull request pane, which owns the conversation, the diff,
  // and everything else the rail does not repeat; the rest are the rail's own
  // shortcuts, and the last row is the move the shared readiness model chose —
  // the same one the pull request page's status card offers.
  interface Props {
    pr: PullRequest;
    ctx: IpcContext;
    serverId: string;
    api: HostApi;
    /** The same checks reading the row above tints its glyph with. */
    checks: ChecksPresentation | null;
    /** The owning tab and project panel are visible. */
    active: boolean;
    /** The Git action that just finished moved this pull request's head. */
    pushCompleted: boolean;
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
    pushCompleted,
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

  // A detail response replaces the indexed summary object. Depend on the
  // target's primitive identity so that replacement cannot restart these reads
  // when the pull request and its head did not change.
  const prNumber = $derived(pr.number);
  const prHeadSha = $derived(pr.headSha);
  const prServerId = $derived(serverId);
  const prProjectScope = $derived(projectScopeOf(ctx.session));

  // A visible compact row is a live status surface, not a snapshot. Ordinary
  // refreshes bypass the client's 30-second mirror; the server still coalesces
  // them against its shorter detail lifetime. A push is different: it makes any
  // remembered mergeability invalid immediately, so that path also clears the
  // host's cache before it reads.
  let lastDetailRefreshAt = 0;
  let detailRefreshInFlight: Promise<void> | null = null;
  let refreshHostAfterCurrent = false;

  async function refreshDetail(forceHost = false): Promise<void> {
    if (!active) return;
    if (detailRefreshInFlight) {
      if (forceHost) refreshHostAfterCurrent = true;
      return detailRefreshInFlight;
    }

    const number = pr.number;
    const project = pullRequests.projects.get(api, serverId, ctx);
    const pullRequest = project.get(number);
    const refresh = forceHost
      ? pullRequest.refreshDetail()
      : pullRequest.loadDetail({ force: true });
    const operation = refresh
      .then(() => {
        if (pr.number === number) lastDetailRefreshAt = Date.now();
      })
      .catch(() => {});
    detailRefreshInFlight = operation;
    try {
      await operation;
    } finally {
      if (detailRefreshInFlight === operation) detailRefreshInFlight = null;
      if (refreshHostAfterCurrent) {
        refreshHostAfterCurrent = false;
        void refreshDetail(true);
      }
    }
  }

  $effect(() => {
    const number = prNumber;
    const headSha = prHeadSha;
    const targetServerId = prServerId;
    const targetProjectScope = prProjectScope;
    const isActive = active;
    merged = false;
    untrack(() => {
      if (
        serverId !== targetServerId ||
        projectScopeOf(ctx.session) !== targetProjectScope
      )
        return;
      if (isActive && document.visibilityState === "visible")
        void refreshDetail();
      void pullRequests.guides
        .loadMetadata(api, targetServerId, ctx, { number, headSha })
        .catch(() => {});
    });
  });

  // Expanding the Git section or returning to its mounted tab runs the effect
  // above. A completed push forces the code-host read even if that visible read
  // is still in flight.
  $effect(() => {
    if (!active || !pushCompleted) return;
    untrack(() => void refreshDetail(true));
  });

  // The fallback exists only while the row can be seen. Browser visibility is
  // checked too because an active Solus tab can sit behind another application.
  $effect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshDetail();
    }, DETAIL_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  function refreshOnWindowFocus() {
    if (
      !active ||
      document.visibilityState !== "visible" ||
      Date.now() - lastDetailRefreshAt < FOCUS_REFRESH_AGE_MS
    )
      return;
    void refreshDetail();
  }

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
  const primary = $derived(readiness?.action ?? null);

  /** Without a tab the pane opens where it was last left, which is what "Open
   *  pull request" promises; the rows below it name the tab they stand for. */
  function openPr(tab?: "activity" | "guide") {
    void session.openPullRequest(pr, {
      ctx,
      serverId,
      target: "aside",
      ...(tab ? { tab } : {}),
    });
    requestInputFocus();
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
          toasts.success(`Review guide ready for PR #${number}`, {
            action: {
              label: "View",
              onAction: () =>
                void session.openPullRequest(
                  { number },
                  {
                    ctx,
                    serverId,
                    target: "aside",
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
      const result = await pullRequest.merge(method);
      if (!result.merged) {
        toasts.error(result.message ?? "The code host refused the merge.");
        return;
      }
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

  function resolveConflicts() {
    void session.startConflictResolverSession(
      { number: pr.number, title: pr.title },
      { ctx },
    );
    requestInputFocus();
  }

  // The rail's row is a state until there is a move, and the move once there
  // is one: a blocker nobody here can clear is reported with its note, and the
  // same row runs the merge, the host action, or the agent handoff otherwise.
  const primaryRow = $derived.by<ActionRowItem | null>(() => {
    if (merged) {
      return {
        key: "pr-primary",
        label: "Merged",
        icon: GitMergeIcon,
        phase: "success",
        disabled: true,
      };
    }
    if (!readiness || readiness.key === "merged" || readiness.key === "closed")
      return null;
    return {
      key: "pr-primary",
      label: refreshingBeforeMerge
        ? "Updating pull request…"
        : merging
          ? "Working…"
          : (primary?.label ?? readiness.headline),
      icon: primary ? ACTION_ICON[primary.kind] : WarningCircleIcon,
      phase: merging ? "loading" : "idle",
      danger: primary?.kind === "resolve-conflicts",
      badge: primary?.kind === "resolve-conflicts" ? "Conflicts" : undefined,
      disabled: !primary || merging,
      tooltip: refreshingBeforeMerge
        ? "Checking the latest code-host state before merging."
        : readiness.note || undefined,
    };
  });

  const rows = $derived.by<ActionRowItem[]>(() => {
    const defs: ActionRowItem[] = [
      {
        key: "pr-open",
        label: "Open pull request",
        icon: GitPullRequestIcon,
        phase: "idle",
      },
      {
        key: "pr-guide",
        label:
          guideRunning || requestingGuide
            ? "Generating review guide…"
            : hasGuide
              ? "Review guide"
              : "Generate review guide",
        icon: EyeglassesIcon,
        phase:
          guideRunning || requestingGuide
            ? "loading"
            : guideMetadata?.current
              ? "success"
              : guideStatus === "failed"
                ? "error"
                : "idle",
        // A guide written against an earlier head is still readable, so it is
        // reported as out of date rather than withheld.
        badge: guideMetadata && !guideMetadata.current ? "Outdated" : undefined,
      },
    ];
    if (checks)
      defs.push({
        key: "pr-checks",
        label: "Checks",
        icon: ChecksIcon,
        phase: "idle",
        badge: checks.label,
        tooltip: checks.tooltip,
        iconTone:
          checks.state === "failing"
            ? "danger"
            : checks.state === "pending"
              ? "running"
              : checks.state === "passing"
                ? "success"
                : undefined,
      });
    if (primaryRow) defs.push(primaryRow);
    return defs;
  });

  function activate(key: string) {
    if (key === "pr-open") openPr();
    // Nothing to read yet: the click produces the guide instead of opening an
    // empty pane, and the pane follows when it is ready.
    else if (key === "pr-guide") {
      if (hasGuide || guideRunning) openPr("guide");
      else void generateGuide();
    } else if (key === "pr-checks") openPr("activity");
    else if (primary?.kind === "merge") void merge(primary.method);
    else if (primary?.kind === "mark-ready") void markReady();
    else if (primary?.kind === "resolve-conflicts") resolveConflicts();
    else if (primary?.kind === "fix-checks")
      onAgentDraft(
        buildPrChecksFixPrompt(pr, orderedChecks(checksSummary).filter(isFailing)),
      );
    else if (primary?.kind === "update-branch" && detail)
      onAgentDraft(
        buildPrUpdateBranchPrompt({
          number: pr.number,
          title: pr.title,
          baseRef: detail.baseRef,
          headRef: detail.headRef,
        }),
      );
  }
</script>

<svelte:window onfocus={refreshOnWindowFocus} />

<div
  class="mx-2 mt-1.5 mb-1 h-px bg-[color-mix(in_srgb,var(--solus-container-border)_55%,transparent)]"
  aria-hidden="true"
></div>
<!-- The card's own heading language one rung in: same shelf type, same uppercase
     tertiary label, so the group reads as part of the Git card rather than a
     second card wedged inside it. The number is a fact, not a control — the
     pull request row above is the way in. -->
<div
  class="flex min-h-6 items-center justify-between gap-2 px-1.5 text-chrome-shelf"
>
  <span
    class="min-w-0 truncate font-medium text-(--solus-text-tertiary) uppercase"
    >Pull request</span
  >
  <span class="shrink-0 font-normal tabular-nums text-(--solus-text-tertiary)"
    >#{pr.number}</span
  >
</div>
{#each rows as row (row.key)}
  <MenuRow item={row} onActivate={() => activate(row.key)} />
{/each}
