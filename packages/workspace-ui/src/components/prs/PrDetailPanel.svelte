<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { PrReviewTarget, RepoRef } from "@solus/contracts/providers";
  import type { IpcContext } from "@solus/contracts/types";
  import { getWorkspaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { prSurfaceError } from "./lib/pr-surface-error";
  import PrReviewPane from "../pr-review/PrReviewPane.svelte";
  import type { HostApi } from "@solus/client-core/host-api";

  /**
   * The pull requests page's detail panel: one review, mounted beside the list
   * it was opened from rather than in place of it.
   *
   * The panel mounts the moment a row is clicked, before the pull request's
   * worktree has been fetched and checked out — `pr` is null until then and the
   * review surface fills in around it, so the click gets a real panel instead of
   * a placeholder that is later swapped.
   */
  let {
    number,
    api,
    serverId,
    ctx,
    title,
    baseRepo,
    fullScreen,
    onToggleFullScreen,
    onClose,
    onStep,
  }: {
    number: number;
    api: HostApi;
    serverId: string;
    /** The *project* scope the list is reading — not this PR's worktree. */
    ctx: IpcContext;
    /** Known from the clicked row, so the panel has a name before detail lands. */
    title: string;
    /** Provider identity for external navigation before detail or checkout lands. */
    baseRepo?: RepoRef;
    fullScreen: boolean;
    /** Absent when the surface has no room for a split in the first place. */
    onToggleFullScreen?: () => void;
    onClose: () => void;
    onStep: (delta: number) => void;
  } = $props();

  const session = getWorkspaceContext();

  let pr = $state<PrReviewTarget | null>(null);
  // A J / K step mounts a new panel, so an answer that lands after this one
  // is gone must not close the panel that replaced it.
  let destroyed = false;
  onDestroy(() => (destroyed = true));

  // Resolving is the slow half of opening a review. The page mounts one panel
  // per pull request, so this asks once, when the panel mounts, with the
  // values it mounted with.
  untrack(() => session.prReview.preparePrReview(number, { ctx, serverId }))
    .then(({ pr: target }) => (pr = target))
    .catch((error) => {
      // A missing GitHub connection is not a failed open: the surface shows
      // the connect action itself.
      if (destroyed || prSurfaceError(error).kind === "github-auth") return;
      toasts.error(`Couldn't open PR #${number}`, {
        description: error instanceof Error ? error.message : String(error),
      });
      onClose();
    });

  // The review and its Activity tab load again whenever `target` changes, so it
  // must change only when one of these values does. Every detail read gives
  // `baseRepo` a new object; an inline `target` built from it changed on each
  // read, and each change started another read — a loop without end.
  const host = $derived(baseRepo?.host);
  const remoteOwner = $derived(baseRepo?.owner);
  const repo = $derived(baseRepo?.repo);
  const target = $derived({ number, title, host, remoteOwner, repo });

  async function refreshTarget(): Promise<void> {
    pr = await api.prOpenReview(ctx, number);
  }

  // The review's chat is whichever open tab is rooted in this PR's worktree —
  // derived rather than stored, so nothing has to be attached or torn down.
  const chatTabId = $derived(
    session.tabOrder.find(
      (tabId) => session.sessionFor(tabId)?.prReview?.number === number,
    ) ?? null,
  );
</script>

<PrReviewPane
  {pr}
  {api}
  {serverId}
  {target}
  targetCtx={ctx}
  {chatTabId}
  {fullScreen}
  {onToggleFullScreen}
  {onStep}
  onExit={onClose}
  onRefreshTarget={refreshTarget}
  embedded
/>
