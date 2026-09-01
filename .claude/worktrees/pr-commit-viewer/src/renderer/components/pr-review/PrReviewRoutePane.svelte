<script lang="ts">
  import type { PrReviewTarget } from "../../../shared/providers";
  import { getWorkspaceContext } from "../../contexts";
  import type { RouteSurfaceProps } from "../ui/lib/pane-surface";
  import { paneActions } from "../ui/lib/pane-actions.svelte";
  import PrReviewPane from "./PrReviewPane.svelte";
  import { serverConnections } from "@client-core/server-connections";

  // The review surface's route adapter. The surface itself is also mounted
  // headless by Review Mode, so it keeps a plain prop contract; everything
  // route-shaped is resolved here.
  //
  // `pr` is null between the click and the worktree being fetched and checked
  // out: the route is entered immediately so the click gets a real page, and the
  // router's payload cache fills this same mounted surface in place when the
  // fetch lands. Re-entering a PR already in the cache skips the fetch entirely.
  let { params, paneId }: RouteSurfaceProps<"prReview"> = $props();

  const session = getWorkspaceContext();
  const pane = paneActions(paneId);
  const embedded = $derived(!pane.isLeading);

  const ref = $derived({ name: "prReview" as const, params });
  const pr = $derived(session.router.resolvedFor<PrReviewTarget>(ref));
  const api = $derived(
    params.serverId
      ? serverConnections.apiFor(params.serverId)
      : serverConnections.primaryApi(),
  );
  const serverId = $derived(
    params.serverId ?? serverConnections.serverIdForApi(api),
  );

  async function refreshTarget(): Promise<void> {
    const ctx = params.cwd ? session.ctxForDirectory(params.cwd) : session.ctx;
    const next = await api.prOpenReview(ctx, params.number);
    session.router.setResolved(ref, next);
  }

  // The review's chat is whichever open tab is rooted in this PR's worktree —
  // derived rather than stored, so nothing has to be attached or torn down.
  const chatTabId = $derived(
    session.tabOrder.find((tabId) => session.sessionFor(tabId)?.prReview?.number === params.number) ??
      null,
  );
</script>

<PrReviewPane
  {pr}
  {api}
  {serverId}
  target={{ number: params.number, title: params.title ?? "" }}
  targetCtx={params.cwd ? session.ctxForDirectory(params.cwd) : session.ctx}
  {chatTabId}
  maximized={pane.maximized}
  onToggleMaximize={pane.toggleMaximize}
  onRefreshTarget={refreshTarget}
  {embedded}
  fullScreen={pane.maximized}
  onToggleFullScreen={pane.toggleMaximize}
  onExit={embedded ? pane.close : undefined}
/>
