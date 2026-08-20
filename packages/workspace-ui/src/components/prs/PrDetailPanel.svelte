<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import type { PrReviewTarget } from "@solus/contracts/providers";
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
   * a placeholder that is later swapped. Targets resolved during this visit are
   * kept, so stepping back and forth with J / K costs nothing after the first
   * pass.
   */
  let {
    number,
    api,
    serverId,
    ctx,
    title,
    fullScreen,
    onToggleFullScreen,
    onOpenRoute,
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
    fullScreen: boolean;
    /** Absent when the surface has no room for a split in the first place. */
    onToggleFullScreen?: () => void;
    onOpenRoute: () => void;
    onClose: () => void;
    onStep: (delta: number) => void;
  } = $props();

  const session = getWorkspaceContext();

  const resolved = new SvelteMap<number, PrReviewTarget>();
  const pr = $derived(resolved.get(number) ?? null);

  // Resolving is the slow half of opening a review. Guard on the number the
  // request was made for so a fast J / K walk cannot land an old checkout on the
  // pull request now showing.
  $effect(() => {
    const requested = number;
    if (resolved.has(requested)) return;
    void session
      .preparePrReview(requested, { ctx, serverId })
      .then(({ pr: target }) => resolved.set(requested, target))
      .catch((error) => {
        // A missing GitHub connection is not a failed open: the surface shows
        // the connect action itself.
        if (prSurfaceError(error).kind === "github-auth") return;
        toasts.error(`Couldn't open PR #${requested}`, {
          description: error instanceof Error ? error.message : String(error),
        });
        onClose();
      });
  });

  async function refreshTarget(): Promise<void> {
    resolved.set(number, await api.prOpenReview(ctx, number));
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
  target={{ number, title }}
  targetCtx={ctx}
  {chatTabId}
  {fullScreen}
  {onToggleFullScreen}
  {onOpenRoute}
  {onStep}
  onExit={onClose}
  onRefreshTarget={refreshTarget}
  embedded
/>
