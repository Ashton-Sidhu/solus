<script lang="ts">
  import { onMount } from 'svelte';
  import { Link2Off, PanelRight, ArrowLeft } from '@lucide/svelte';
  import { createAppCore } from '@solus/workspace-ui/contexts/app/app-core';
  import { sharesStore, serversStore } from '@solus/workspace-ui/contexts';
  import { setPopoverLayer } from '@solus/workspace-ui/components/popoverLayer.svelte';
  import { visibleRef } from '@solus/workspace-ui/contexts/workspace/routing/location';
  import { Button } from '@solus/workspace-ui/components/ui/button';
  import * as Tooltip from '@solus/workspace-ui/components/ui/tooltip';
  import * as Empty from '@solus/workspace-ui/components/ui/empty';
  import TaskPage from '@solus/workspace-ui/components/tasks/task-page/TaskPage.svelte';
  import WorkPane from '@solus/workspace-ui/components/work/WorkPane.svelte';
  import SessionRecordPage from '@solus/workspace-ui/components/session/record/SessionRecordPage.svelte';
  import SharedPrompt from '@solus/workspace-ui/components/sharing/SharedPrompt.svelte';
  import { GuestShell } from './shell/guest-shell.svelte';
  import GuestRail from './shell/GuestRail.svelte';
  import { guestBoot, type GuestShare } from './lib/guest-boot.svelte';

  let { serverId, share, displayName }: { serverId: string; share: GuestShare; displayName: string } = $props();
  const { settings, session } = createAppCore(new GuestShell());
  serversStore.trackConnections();
  let overlayEl: HTMLElement | null = $state(null);
  setPopoverLayer({ get el() { return overlayEl; } });
  let cloudSessionId = $state<string | null>(share.resource.kind === 'session' ? share.resource.id : null);
  let railOpen = $state(!window.matchMedia('(pointer: coarse)').matches);
  const list = $derived(sharesStore.listFor(serverId, share.resource));
  const role = $derived(list?.callerRole === 'editor' ? 'editor' : list?.callerRole === 'viewer' ? 'viewer' : share.role);
  const task = $derived(share.resource.kind === 'task' ? session.tasksStore.get(share.resource.id) : null);
  const title = $derived(share.resource.kind === 'work' ? session.worksStore.get(share.resource.id)?.title ?? 'Shared document' : task?.isKnown ? task.title : 'Shared session');
  const activeWork = $derived.by(() => {
    for (const pane of session.router.panes) {
      const ref = visibleRef(pane);
      if (ref?.name === 'work') return { params: ref.params, paneId: pane.id };
    }
    return null;
  });
  function openShared(): void {
    cloudSessionId = share.resource.kind === 'session' ? share.resource.id : null;
    if (share.resource.kind === 'work') session.openRoute({ name: 'work', params: { workId: share.resource.id, serverId } });
  }
  onMount(() => {
    void sharesStore.load(serverId, share.resource);
    openShared();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => settings.setSystemTheme(media.matches);
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  });
</script>

<Tooltip.Provider>
  <div bind:this={overlayEl} class="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-(--background) text-workspace-chrome text-foreground" data-testid="guest-shell">
    <header class="flex h-12 shrink-0 items-center gap-3 border-b border-(--hairline) px-4 pt-[env(safe-area-inset-top)]" data-testid="guest-header">
      {#if cloudSessionId && share.resource.kind === 'task'}<Button variant="ghost" size="icon-sm" aria-label="Back to the task" onclick={openShared}><ArrowLeft size={14} /></Button>{/if}
      <span class="min-w-0 flex-1 truncate font-medium">{title}</span>
      <span class="rounded-full border border-(--hairline) px-2 py-1 text-muted-foreground" data-testid="guest-role">{role === 'editor' ? 'Editor' : 'Viewer'}</span>
      <span class="max-w-40 truncate" data-testid="guest-name-label">{displayName}</span>
      <Button variant="ghost" size="icon-sm" aria-label={railOpen ? 'Hide the panel' : 'Show the panel'} aria-pressed={railOpen} onclick={() => railOpen = !railOpen}><PanelRight size={14} /></Button>
    </header>
    <div class="@container flex min-h-0 flex-1">
      <main class="guest-pane flex min-h-0 min-w-0 flex-1 flex-col" data-testid="guest-main">
        {#if cloudSessionId}
          <SessionRecordPage params={{ serverId, sessionId: cloudSessionId }} paneId="">
            {#snippet composer()}{#key cloudSessionId}<SharedPrompt ownAccount={!!guestBoot.accountUserId} {serverId} sessionId={cloudSessionId!} editable={role === 'editor'} />{/key}{/snippet}
          </SessionRecordPage>
        {:else if activeWork}
          <WorkPane params={activeWork.params} paneId={activeWork.paneId} />
        {:else if share.resource.kind === 'task'}
          <TaskPage params={{ taskId: share.resource.id, serverId }} onRequestClose={() => {}} onOpenSession={(sessionId) => cloudSessionId = sessionId} />
        {:else}<p class="p-6 text-muted-foreground" role="status">Opening the document…</p>{/if}
      </main>
      {#if railOpen}
        <div class="contents @max-[40rem]:hidden">
          <GuestRail {serverId} resource={share.resource} resourceTitle={title} {role} screenSessionId={cloudSessionId} sessions={task?.sessions ?? []} liveTitleFor={() => null} onOpenSession={(sessionId) => cloudSessionId = sessionId} onOpenResource={openShared} resourceOnScreen={!cloudSessionId || share.resource.kind === 'session'} />
        </div>
      {/if}
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
