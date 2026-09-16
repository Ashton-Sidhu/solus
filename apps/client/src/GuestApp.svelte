<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Users as UsersIcon } from "@lucide/svelte";
  import { setPopoverLayer } from "@solus/workspace-ui/components/popoverLayer.svelte";
  import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { visibleRef } from "@solus/workspace-ui/contexts/workspace/routing/location";
  import { serversStore, sharesStore } from "@solus/workspace-ui/contexts";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { connectionStatusLabel } from "@solus/client-core/connection-display";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";
  import ConversationView from "@solus/workspace-ui/components/conversation/ConversationView.svelte";
  import WorkPane from "@solus/workspace-ui/components/work/WorkPane.svelte";
  import { guestBoot, type GuestShare } from "./lib/guest-boot.svelte";
  import { webState } from "./lib/web-state.svelte";
  import { GuestShell } from "./shell/guest-shell.svelte";

  /**
   * The guest shell (docs/plans/multiplayer-sharing.md §4.2): one resource and
   * nothing host-wide. It builds the same app core the workspace uses, so the
   * conversation and work surfaces render as they do for a member, but it opens
   * no catalog, no sidebar, no project panel, no palette, and no settings — the
   * host would refuse those calls, and a guest was never promised them.
   */
  interface Props {
    serverId: string;
    share: GuestShare;
    displayName: string;
  }
  let { serverId, share, displayName }: Props = $props();

  const shell = new GuestShell();
  const { settings, session } = createAppCore(shell);
  setupAgentEvents(session);
  // The transcript's reachability row reads the host's status from here; the
  // rest of `serversStore.init()` (catalog, discovery, directory) is host-wide.
  serversStore.trackConnections();

  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({
    get el() {
      return overlayEl;
    },
  });

  onMount(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => settings.setSystemTheme(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  });

  let openError = $state<string | null>(null);

  // The host named the resource at admission; open exactly that, on that host.
  onMount(() => {
    void sharesStore.load(serverId, share.resource);
    untrack(() => void openShared());
  });

  async function openShared(): Promise<void> {
    openError = null;
    try {
      if (share.resource.kind === "work") {
        session.openRoute({ name: "work", params: { workId: share.resource.id, serverId } });
        return;
      }
      const meta = await readSessionMeta(serverId, share.resource.id);
      if (!meta) throw new Error("This session could not be read from its host.");
      await session.resumeSession(meta);
    } catch (error) {
      openError = error instanceof Error ? error.message : String(error);
    }
  }

  const router = session.router;
  const activeWorkRoute = $derived.by(() => {
    for (const pane of router.panes) {
      const ref = visibleRef(pane);
      if (ref?.name === "work") return { paneId: pane.id, params: ref.params };
    }
    return null;
  });
  const tabId = $derived(session.activeTabId);
  const hasTab = $derived(!!tabId && !!session.tabs[tabId]);

  // A work surface can still close itself (Escape, a shell verb). There is
  // nothing else to show a guest, so the resource comes straight back.
  let hadWorkRoute = false;
  $effect(() => {
    const open = !!activeWorkRoute;
    if (hadWorkRoute && !open && share.resource.kind === "work" && !openError) untrack(() => void openShared());
    hadWorkRoute = open;
  });

  // The role the host holds now, not the one the link carried at admission: a
  // link changed from editor to viewer keeps the guest connected with the new role.
  const list = $derived(sharesStore.listFor(serverId, share.resource));
  const role = $derived(list?.callerRole === "editor" ? "editor" : list?.callerRole === "viewer" ? "viewer" : share.role);
  const title = $derived(
    share.resource.kind === "work"
      ? (session.worksStore.get(share.resource.id)?.title ?? "Shared document")
      : (hasTab ? session.sessionFor(tabId)?.title : undefined) ?? "Shared session",
  );
  const connectionLabel = $derived(
    connectionStatusLabel(webState.connectionStatus, {
      attempt: webState.connectionAttempt,
      hasConnected: webState.hasConnected,
    }),
  );
  // A revoked link blocks the transport; the overlay says why, so the chip
  // ("Sign-in required" for a member) would only contradict it here.
  const showConnectionStatus = $derived(webState.connectionStatus !== "connected" && !guestBoot.revoked);
</script>

<svelte:head>
  <title>{title} · Solus</title>
</svelte:head>

<Tooltip.Provider delayDuration={450} skipDelayDuration={300} disableHoverableContent>
  <div
    bind:this={overlayEl}
    data-solus-ui
    class="click-through-shell"
    style="position:fixed;inset:0;z-index:10010"
  ></div>

  <div class="flex h-full w-full flex-col bg-(--solus-container-bg) text-workspace-chrome" data-solus-ui data-testid="guest-shell">
    <header class="flex h-11 shrink-0 items-center gap-3 border-b border-(--solus-container-border) px-4">
      <span class="flex shrink-0 items-center gap-1.5 font-medium text-(--solus-text-primary)">
        <UsersIcon size={14} class="text-(--solus-accent)" />
        Solus
      </span>
      <span class="min-w-0 flex-1 truncate text-(--solus-text-secondary)" data-testid="guest-title">{title}</span>
      {#if showConnectionStatus}
        <span class="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-(--solus-surface-hover) px-2 py-0.5 text-[0.875em] tabular-nums text-(--solus-text-tertiary)">
          <span class="h-1.5 w-1.5 rounded-full bg-(--solus-accent)" class:animate-pulse={webState.connectionStatus === "connecting" || webState.connectionStatus === "reconnecting"}></span>
          <span class="max-w-[9rem] truncate">{connectionLabel}</span>
        </span>
      {/if}
      <span class="shrink-0 rounded-full border border-(--solus-container-border) px-2 py-0.5 text-[0.875em] text-(--solus-text-tertiary)" data-testid="guest-role">
        {role === "editor" ? "Editor" : "Viewer"}
      </span>
      <span class="hidden shrink-0 text-[0.875em] text-(--solus-text-tertiary) sm:inline" data-testid="guest-name-label">You’re {displayName}</span>
    </header>

    <main class="guest-pane relative flex min-h-0 flex-1 flex-col" data-testid="guest-main">
      {#if openError}
        <div class="grid min-h-0 flex-1 place-items-center p-6 text-center">
          <div class="flex max-w-[26rem] flex-col items-center gap-3">
            <p class="font-medium text-(--solus-text-primary)">Couldn’t open what was shared.</p>
            <p class="text-[0.875em] text-(--solus-text-tertiary)">{openError}</p>
            <button type="button" class="min-h-9 rounded-lg border border-(--solus-container-border) px-3.5 font-medium text-(--solus-text-secondary)" onclick={() => void openShared()}>Try again</button>
          </div>
        </div>
      {:else if share.resource.kind === "work"}
        {#if activeWorkRoute}
          <div class="flex min-h-0 flex-1 flex-col">
            <WorkPane params={activeWorkRoute.params} paneId={activeWorkRoute.paneId} />
          </div>
        {:else}
          <div class="grid min-h-0 flex-1 place-items-center text-(--solus-text-tertiary)" role="status">Opening the document…</div>
        {/if}
      {:else if hasTab}
        <div class="flex min-h-0 flex-1 flex-col">
          <ConversationView {tabId} showActions={false} bandAbove={false} />
        </div>
        {#if role === "editor"}
          <p class="shrink-0 border-t border-(--solus-container-border) px-4 py-2 text-center text-[0.875em] text-(--solus-text-tertiary)" data-testid="guest-session-note">
            You can follow this session live. Sending prompts from a guest link arrives later.
          </p>
        {/if}
      {:else}
        <div class="grid min-h-0 flex-1 place-items-center text-(--solus-text-tertiary)" role="status">Opening the session…</div>
      {/if}
    </main>
  </div>

  {#if guestBoot.phase === "revoked"}
    <div class="fixed inset-0 z-[10008] grid place-items-center bg-[color-mix(in_srgb,var(--solus-modal-scrim)_70%,transparent)] px-6" role="alertdialog" aria-label="This link no longer works" data-testid="guest-revoked">
      <div class="flex max-w-[24rem] flex-col items-center gap-2 rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-6 text-center">
        <p class="font-medium text-(--solus-text-primary)">This link no longer works</p>
        <p class="text-[0.875em] text-(--solus-text-tertiary)">The person who shared it turned the link off or made a new one. Ask them for the current link.</p>
      </div>
    </div>
  {/if}
</Tooltip.Provider>

<style>
  /* The one pane a guest has. Every surface below reads its width from here,
     the same named container `WorkspaceBody` declares on `.primary-column`. */
  .guest-pane {
    container: pane / inline-size;
  }
</style>
