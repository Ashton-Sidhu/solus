<script lang="ts">
  import { onMount } from 'svelte';
  import { Link2Off } from '@lucide/svelte';
  import { userKey } from '@solus/contracts/user';
  import { createAppCore } from '@solus/workspace-ui/contexts/app/app-core';
  import { sharesStore, serversStore } from '@solus/workspace-ui/contexts';
  import { presenceStore } from '@solus/workspace-ui/contexts/presence/presence.store.svelte';
  import { setPopoverLayer } from '@solus/workspace-ui/components/popoverLayer.svelte';
  import { visibleRef } from '@solus/workspace-ui/contexts/workspace/routing/location';
  import * as Tooltip from '@solus/workspace-ui/components/ui/tooltip';
  import * as Empty from '@solus/workspace-ui/components/ui/empty';
  import PresenceStack from '@solus/workspace-ui/components/presence/PresenceStack.svelte';
  import WorkPane from '@solus/workspace-ui/components/work/WorkPane.svelte';
  import SessionRecordPage from '@solus/workspace-ui/components/session/record/SessionRecordPage.svelte';
  import SharedPrompt from '@solus/workspace-ui/components/sharing/SharedPrompt.svelte';
  import { GuestShell } from './shell/guest-shell.svelte';
  import { guestAccessLine, guestRoleLabel } from './shell/lib/guest-access';
  import { guestBoot, type GuestShare } from './lib/guest-boot.svelte';

  /**
   * A share link's page (docs/plans/multiplayer-sharing.md §4.2): the shared
   * resource as the app draws it in a pane, with no workspace around it. The
   * pane controls' corner holds what a guest needs instead: who else is here,
   * and the guest's standing. A link opens a work or a session; a task has no
   * link of its own, because its organization sees it.
   */
  let { serverId, share, displayName }: { serverId: string; share: GuestShare; displayName: string } = $props();
  const { settings, session } = createAppCore(new GuestShell());
  serversStore.trackConnections();
  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({ get el() { return overlayEl; } });
  const sharedSessionId = $derived(share.resource.kind === 'session' ? share.resource.id : null);
  const list = $derived(sharesStore.listFor(serverId, share.resource));
  const role = $derived(list?.callerRole === 'editor' || list?.callerRole === 'commenter' || list?.callerRole === 'viewer' ? list.callerRole : share.role);
  const activeWork = $derived.by(() => {
    for (const pane of session.router.panes) {
      const ref = visibleRef(pane);
      if (ref?.name === 'work') return { params: ref.params, paneId: pane.id };
    }
    return null;
  });
  const people = $derived(sharedSessionId ? presenceStore.sessionPeople(serverId, sharedSessionId) : []);
  const room = $derived(sharedSessionId ? presenceStore.sessionRoom(serverId, sharedSessionId) : undefined);
  const activeUserId = $derived(room?.activeTurn ? userKey(room.activeTurn.author.id) : null);
  // The page headers reserve the cluster's width, as they reserve the pane controls'.
  let clusterWidth = $state(0);

  onMount(() => {
    void sharesStore.load(serverId, share.resource);
    if (share.resource.kind === 'work') session.openRoute({ name: 'work', params: { workId: share.resource.id, serverId } });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => settings.setSystemTheme(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  });
</script>

<Tooltip.Provider>
  <div
    bind:this={overlayEl}
    class="guest-pane relative flex h-dvh min-h-0 flex-col overflow-hidden bg-(--solus-container-bg) pt-[env(safe-area-inset-top)] text-workspace-chrome text-foreground"
    style:--solus-pane-chrome-inset="{clusterWidth + 16}px"
    data-testid="guest-shell"
  >
    <main class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="guest-main">
      {#if sharedSessionId}
        <SessionRecordPage params={{ serverId, sessionId: sharedSessionId }} paneId="">
          {#snippet composer()}{#key sharedSessionId}<SharedPrompt ownAccount={!!guestBoot.accountUserId} {serverId} sessionId={sharedSessionId!} editable={role === 'editor'} />{/key}{/snippet}
        </SessionRecordPage>
      {:else if activeWork}
        <WorkPane params={activeWork.params} paneId={activeWork.paneId} />
      {:else}<p class="p-6 text-muted-foreground" role="status">Opening the document…</p>{/if}
    </main>

    <!-- Where the app puts the pane's controls. After the page, as PaneChrome is,
         so the page's title row never covers it. -->
    <div
      class="no-drag absolute top-[env(safe-area-inset-top)] right-2.5 z-30 flex h-(--solus-chrome-row-h,2.5rem) items-center gap-1.5 pointer-coarse:h-14"
      bind:clientWidth={clusterWidth}
      data-testid="guest-cluster"
    >
      {#if people.length > 0}
        <PresenceStack {people} {activeUserId} detail={(person) => person.userId === activeUserId ? 'running a turn' : person.isComposing ? 'typing…' : null} />
      {/if}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <span
              {...props}
              class="flex h-6 max-w-48 items-center gap-1 overflow-hidden rounded-full px-2 text-muted-foreground shadow-[inset_0_0_0_0.5px_var(--hairline)]"
              data-testid="guest-role"
            >
              <span class="shrink-0 text-foreground">{guestRoleLabel(role)}</span>
              <span class="truncate @max-[30rem]/pane:hidden" data-testid="guest-name-label">· {displayName}</span>
            </span>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content value="{displayName}: {guestAccessLine(share.resource.kind, role)}" />
      </Tooltip.Root>
    </div>

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
