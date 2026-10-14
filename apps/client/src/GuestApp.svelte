<script lang="ts">
  import { onMount } from 'svelte';
  import { Link2Off } from '@lucide/svelte';
  import { createAppCore } from '@solus/workspace-ui/contexts/app/app-core';
  import { initializeRuntime } from '@solus/workspace-ui/contexts/app/runtime-boot';
  import { setupAgentEvents } from '@solus/workspace-ui/hooks/agentEvents.svelte';
  import { sharesStore, serversStore } from '@solus/workspace-ui/contexts';
  import { presenceStore } from '@solus/workspace-ui/contexts/presence/presence.store.svelte';
  import { setPopoverLayer } from '@solus/workspace-ui/components/popoverLayer.svelte';
  import { activeSurface } from '@solus/workspace-ui/contexts/workspace/routing/location';
  import * as Tooltip from '@solus/workspace-ui/components/ui/tooltip';
  import * as Empty from '@solus/workspace-ui/components/ui/empty';
  import WorkPane from '@solus/workspace-ui/components/work/WorkPane.svelte';
  import WebDesktopLayout from './shell/desktop/WebDesktopLayout.svelte';
  import { GuestShell } from './shell/guest-shell.svelte';
  import { guestBoot, type GuestShare } from './lib/guest-boot.svelte';

  /**
   * A share link's page (docs/plans/host-sharing.md §10): the real workspace, opened
   * on the one shared resource. A session opens as a tab in the ordinary layout —
   * the sidebar, the band, the panel, and the composer with its pickers — and every
   * control reads what the host lets this guest do (`host.me.may`). A work opens
   * in its pane. A task has no link of its own, because its organization sees it.
   */
  let { serverId, share }: { serverId: string; share: GuestShare } = $props();
  const { settings, session, sessionSidebarStore } = createAppCore(new GuestShell(share.resource.kind));
  serversStore.trackConnections();
  setupAgentEvents(session);
  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({ get el() { return overlayEl; } });
  const sharedSessionId = $derived(share.resource.kind === 'session' ? share.resource.id : null);
  const activeWork = $derived.by(() => {
    for (const pane of session.router.panes) {
      const ref = activeSurface(pane);
      if (ref?.name === 'work') return { params: ref.params, paneId: pane.id };
    }
    return null;
  });
  /** On the Solus API's copy the session reads only until the computer that runs it is back (host-sharing.md §4.2). */
  const readOnlyReason = $derived(guestBoot.live ? null : 'The computer this session runs on is offline. You can read it; prompts resume when it is back.');

  onMount(() => presenceStore.listen());
  $effect(() => presenceStore.reportWorkspaceFocus(session));

  onMount(() => {
    void sharesStore.load(serverId, share.resource);
    const stopRuntime = initializeRuntime(session, sessionSidebarStore);
    if (sharedSessionId) void session.revealSession(sharedSessionId, serverId);
    else session.openRoute({ name: 'work', params: { workId: share.resource.id, serverId } });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => settings.setSystemTheme(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => {
      stopRuntime();
      media.removeEventListener('change', apply);
    };
  });
</script>

<Tooltip.Provider>
  <div
    bind:this={overlayEl}
    class="guest-pane relative flex h-dvh min-h-0 flex-col overflow-hidden bg-(--solus-container-bg) pt-[env(safe-area-inset-top)] text-workspace-chrome text-foreground"
    data-testid="guest-shell"
  >
    <main class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="guest-main">
      {#if sharedSessionId}
        <WebDesktopLayout onAttachFile={() => {}} {readOnlyReason} />
      {:else if activeWork}
        <WorkPane params={activeWork.params} paneId={activeWork.paneId} />
      {:else}<p class="p-6 text-muted-foreground" role="status">Opening the document…</p>{/if}
    </main>

    {#if guestBoot.revoked}
      <div class="fixed inset-0 z-[10008] grid place-items-center bg-(--background)/95 px-6" role="alertdialog" aria-label="This link no longer works" data-testid="guest-revoked">
        <Empty.Root class="max-w-sm flex-none border">
          <Empty.Header><Empty.Media variant="icon"><Link2Off /></Empty.Media><Empty.Title>This link no longer works</Empty.Title><Empty.Description>The person who shared it removed or replaced the link. Ask for the current link.</Empty.Description></Empty.Header>
        </Empty.Root>
      </div>
    {/if}
  </div>
</Tooltip.Provider>

<style>
  .guest-pane { container: pane / inline-size; }
</style>
