<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    ArrowLeft as ArrowLeftIcon,
    CircleAlert as CircleAlertIcon,
    FileText as FileTextIcon,
    Link2Off as LinkOffIcon,
    MessageSquare as MessageSquareIcon,
    PanelRight as PanelRightIcon,
    SquareCheck as SquareCheckIcon,
  } from "@lucide/svelte";
  import { setPopoverLayer } from "@solus/workspace-ui/components/popoverLayer.svelte";
  import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { visibleRef } from "@solus/workspace-ui/contexts/workspace/routing/location";
  import { serversStore, sharesStore } from "@solus/workspace-ui/contexts";
  import { readSessionMeta } from "@solus/client-core/session-meta";
  import { findOpenTabForSession, sessionTitle } from "@solus/workspace-ui/lib/sessionUtils";
  import { connectionStatusLabel } from "@solus/client-core/connection-display";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";
  import * as Empty from "@solus/workspace-ui/components/ui/empty";
  import { Button } from "@solus/workspace-ui/components/ui/button";
  import { Skeleton } from "@solus/workspace-ui/components/ui/skeleton";
  import WorkspaceMark from "@solus/workspace-ui/components/ui/WorkspaceMark.svelte";
  import SessionPresence from "@solus/workspace-ui/components/presence/SessionPresence.svelte";
  import { initialsFor } from "@solus/workspace-ui/components/ui/list-page/list-page";
  import ConversationView from "@solus/workspace-ui/components/conversation/ConversationView.svelte";
  import EditorInputCard from "@solus/workspace-ui/components/input/EditorInputCard.svelte";
  import { ComposerDock } from "@solus/workspace-ui/components/input/lib/composer-dock.svelte";
  import TaskPage from "@solus/workspace-ui/components/tasks/task-page/TaskPage.svelte";
  import WorkPane from "@solus/workspace-ui/components/work/WorkPane.svelte";
  import { createWebAttachments } from "./components/input/lib/attachments";
  import { guestBoot, type GuestShare } from "./lib/guest-boot.svelte";
  import { webState } from "./lib/web-state.svelte";
  import { GuestShell } from "./shell/guest-shell.svelte";
  import GuestRail from "./shell/GuestRail.svelte";

  /**
   * The guest shell (docs/plans/multiplayer-sharing.md §4.2): one resource and
   * nothing host-wide. It builds the same app core the workspace uses, so the
   * conversation, work, and task surfaces render as they do for a member, but it
   * opens no catalog, no sidebar, no project panel, no palette, and no settings —
   * the host would refuse those calls, and a guest was never promised them.
   *
   * A shared task is a page with doors: its sessions open in this shell, and a
   * "Back to task" control returns. A session is the workspace's own
   * conversation column — transcript, floating composer dock, held band — so a
   * guest reads it the way a member does. An editor's composer is live, and the
   * host runs those turns on the seat of whoever made the link; a viewer's is
   * there but takes no input, and says why in place of a prompt.
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
  const { attachFile } = createWebAttachments(session);
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
      if (share.resource.kind === "task") {
        session.openRoute({ name: "task", params: { taskId: share.resource.id, serverId } });
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
  const activePageRoute = $derived.by(() => {
    for (const pane of router.panes) {
      const ref = visibleRef(pane);
      if (ref?.name === "work") return { paneId: pane.id, work: ref.params, task: null };
      if (ref?.name === "task") return { paneId: pane.id, work: null, task: ref.params };
    }
    return null;
  });
  const activeWorkRoute = $derived(activePageRoute?.work ? { paneId: activePageRoute.paneId, params: activePageRoute.work } : null);
  const activeTaskRoute = $derived(activePageRoute?.task ? { paneId: activePageRoute.paneId, params: activePageRoute.task } : null);
  const tabId = $derived(session.activeTabId);
  const hasTab = $derived(!!tabId && !!session.tabs[tabId]);
  /** A session opened from the shared task's page: the way back is the task. */
  const inTaskSession = $derived(share.resource.kind === "task" && !activeTaskRoute && hasTab);

  // A work surface can still close itself (Escape, a shell verb). There is
  // nothing else to show a guest, so the resource comes straight back. A task
  // page closes when one of its sessions opens; that one is the guest's to leave.
  let hadPageRoute = false;
  $effect(() => {
    const open = !!activePageRoute;
    const pageResource = share.resource.kind === "work" || share.resource.kind === "task";
    if (hadPageRoute && !open && pageResource && !openError && !session.activeTabId) untrack(() => void openShared());
    hadPageRoute = open;
  });

  // The role the host holds now, not the one the link carried at admission: a
  // link changed from editor to viewer keeps the guest connected with the new role.
  const list = $derived(sharesStore.listFor(serverId, share.resource));
  const role = $derived(list?.callerRole === "editor" ? "editor" : list?.callerRole === "viewer" ? "viewer" : share.role);
  // The task's frame, minted here: `peek` on an id no host has described yet
  // reads no state, so a name derived through it would never learn the title.
  const taskFrame = $derived(share.resource.kind === "task" ? session.tasksStore.get(share.resource.id) : null);
  /** The shared resource's own name: the task crumb while one of its sessions is open. */
  const resourceTitle = $derived(
    share.resource.kind === "work"
      ? (session.worksStore.get(share.resource.id)?.title ?? "Shared document")
      : taskFrame
        ? (taskFrame.isKnown ? taskFrame.title : "Shared task")
        : (hasTab ? session.sessionFor(tabId)?.title : undefined) ?? "Shared session",
  );
  /** What is on screen: a task's session names itself, everything else is the resource. */
  const title = $derived(
    inTaskSession ? ((hasTab ? session.sessionFor(tabId)?.title : undefined) ?? "Session") : resourceTitle,
  );
  const onSessionScreen = $derived(share.resource.kind === "session" || inTaskSession);
  const screenSessionId = $derived(hasTab ? (session.sessionFor(tabId)?.id ?? null) : null);
  const guestInitials = $derived(initialsFor(displayName));

  // The rail: what you're in. Open by default where there is a keyboard; the
  // toggle in the band is its reverse. Under a shared task it lists the task's
  // sessions, which the task frame holds once the page has loaded it.
  let railOpen = $state(!window.matchMedia("(pointer: coarse)").matches);
  const taskSessions = $derived(taskFrame?.sessions ?? []);

  function liveTitleFor(sessionId: string): string | null {
    const openTabId = findOpenTabForSession(sessionId, session.tabs, session.sessions, session.tabOrder, undefined, serverId);
    const live = openTabId ? session.sessionFor(openTabId) : undefined;
    return live ? sessionTitle(live) : null;
  }

  /** One of the task's sessions, from the rail: focus it if open, else resume it here. */
  async function openTaskSession(sessionId: string): Promise<void> {
    openError = null;
    try {
      const openTabId = findOpenTabForSession(sessionId, session.tabs, session.sessions, session.tabOrder, undefined, serverId);
      if (openTabId) {
        session.selectTab(openTabId);
        return;
      }
      const meta = await readSessionMeta(serverId, sessionId);
      if (!meta) throw new Error("This session could not be read from its host.");
      await session.resumeSession(meta);
    } catch (error) {
      openError = error instanceof Error ? error.message : String(error);
    }
  }
  /** The composer takes input from an editor, on the shared session or one of the
   *  task's; a viewer gets the same bar with this in place of a prompt. */
  const composerReadOnlyReason = $derived(
    role === "editor" ? null : "You can view this session but not send prompts.",
  );
  // The composer floats over the transcript and the column holds a band for it
  // (ADR-0027), exactly as `WorkspaceBody` does for the workspace's own dock.
  let inputDockEl: HTMLElement | undefined = $state();
  const composerDock = new ComposerDock();
  $effect(() => {
    const dock = inputDockEl;
    if (!dock) return;
    return composerDock.observe(dock);
  });
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

  <div class="flex h-full w-full flex-col bg-(--background) text-workspace-chrome" data-solus-ui data-testid="guest-shell">
    <!-- The band the workspace draws above its own transcript, with the crumb
         a guest has: the mark, then the one resource, then who is here and who
         the guest is. Opaque and in flow, as the phone's navbar is. -->
    <header
      class="guest-header @container relative z-[3] flex h-[2.875rem] shrink-0 items-center gap-px border-b border-(--hairline) bg-(--background) pr-3 pl-3.5 pointer-coarse:h-14 pointer-coarse:pr-[max(0.75rem,env(safe-area-inset-right,0px))] pointer-coarse:pl-[max(0.875rem,env(safe-area-inset-left,0px))]"
    >
      <span class="flex shrink-0 items-center gap-[0.4375rem] pr-1 font-medium tracking-[-0.01em] text-(--solus-text-primary)">
        <WorkspaceMark class="size-[1.125rem] shrink-0" />
        <span class="max-[28rem]:sr-only">Solus</span>
      </span>
      <span class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30 max-[28rem]:hidden" aria-hidden="true">/</span>

      {#if inTaskSession}
        <!-- The task is the crumb before the session: the way back is where you came from. -->
        <button
          type="button"
          class="flex h-[1.875rem] min-w-0 max-w-[clamp(6rem,24cqw,14rem)] shrink cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-1.5 text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground pointer-coarse:h-9"
          title="Back to {resourceTitle}"
          data-testid="guest-back-to-task"
          onclick={() => void openShared()}
        >
          <ArrowLeftIcon size={14} class="shrink-0" />
          <span class="truncate">{resourceTitle}</span>
        </button>
        <span class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30" aria-hidden="true">/</span>
      {/if}

      <span class="flex h-[1.875rem] min-w-0 shrink items-center gap-1.5 px-1.5">
        {#if activeWorkRoute || share.resource.kind === "work"}
          <FileTextIcon size={14} class="shrink-0 text-muted-foreground" />
        {:else if activeTaskRoute || (share.resource.kind === "task" && !inTaskSession)}
          <SquareCheckIcon size={14} class="shrink-0 text-muted-foreground" />
        {:else}
          <MessageSquareIcon size={14} class="shrink-0 text-muted-foreground" />
        {/if}
        <span class="truncate font-medium text-(--solus-text-primary)" data-testid="guest-title">{title}</span>
      </span>

      <span class="min-w-2 flex-1" aria-hidden="true"></span>

      {#if showConnectionStatus}
        <span class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-(--solus-surface-hover) px-2 text-[0.875em] tabular-nums text-(--solus-text-tertiary)">
          <span class="size-1.5 rounded-full bg-(--solus-accent)" class:animate-pulse={webState.connectionStatus === "connecting" || webState.connectionStatus === "reconnecting"}></span>
          <span class="max-w-[9rem] truncate">{connectionLabel}</span>
        </span>
      {/if}

      {#if onSessionScreen && screenSessionId}
        <SessionPresence {serverId} sessionId={screenSessionId} {title} class="mx-1" />
      {/if}

      <span
        class="inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[0.875em] font-medium {role === 'editor'
          ? 'border-transparent bg-(--solus-accent-light) text-(--solus-accent)'
          : 'border-(--solus-container-border) text-(--solus-text-tertiary)'}"
        title={role === "editor" ? "You can read and send prompts" : "You can read but not send prompts"}
        data-testid="guest-role"
      >
        {role === "editor" ? "Editor" : "Viewer"}
      </span>

      <span
        class="ml-1.5 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-(--solus-container-border) py-0.5 pr-2.5 pl-0.5 pointer-coarse:h-8"
        title="You’re here as {displayName}"
        data-testid="guest-name-label"
      >
        <span class="inline-flex size-[1.375rem] shrink-0 items-center justify-center rounded-full bg-(--solus-accent-light) text-[0.625rem] font-medium leading-none text-(--solus-accent) select-none pointer-coarse:size-6" aria-hidden="true">{guestInitials}</span>
        <span class="max-w-[10rem] truncate text-(--solus-text-secondary) max-[36rem]:sr-only">{displayName}</span>
      </span>

      <button
        type="button"
        class="ml-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground @max-[40rem]:hidden pointer-coarse:size-9 {railOpen ? 'bg-accent text-foreground' : ''}"
        title={railOpen ? "Hide the panel" : "Show the panel"}
        aria-label={railOpen ? "Hide the panel" : "Show the panel"}
        aria-pressed={railOpen}
        data-testid="guest-rail-toggle"
        onclick={() => (railOpen = !railOpen)}
      >
        <PanelRightIcon size={14} />
      </button>
    </header>

    <!-- The row under the band: the one pane, and the rail beside it where the
         window is wide enough to hold both. A phone keeps the band's crumb and
         the task page's own sessions list, which reach the same places. -->
    <div class="guest-row @container flex min-h-0 flex-1">
    <main class="guest-pane relative flex min-h-0 flex-1 flex-col" data-testid="guest-main">
      {#if openError}
        <div class="grid min-h-0 flex-1 place-items-center p-6">
          <Empty.Root class="max-w-[26rem] flex-none border">
            <Empty.Header>
              <Empty.Media variant="icon"><CircleAlertIcon /></Empty.Media>
              <Empty.Title>Couldn’t open what was shared</Empty.Title>
              <Empty.Description>{openError}</Empty.Description>
            </Empty.Header>
            <Empty.Content>
              <Button variant="outline" onclick={() => void openShared()}>Try again</Button>
            </Empty.Content>
          </Empty.Root>
        </div>
      {:else if activeWorkRoute}
        <div class="flex min-h-0 flex-1 flex-col">
          <WorkPane params={activeWorkRoute.params} paneId={activeWorkRoute.paneId} />
        </div>
      {:else if activeTaskRoute}
        <div class="flex min-h-0 flex-1 flex-col" data-testid="guest-task">
          <TaskPage params={activeTaskRoute.params} paneId={activeTaskRoute.paneId} onRequestClose={() => {}} />
        </div>
      {:else if hasTab}
        <!-- The header above is opaque and in flow, like the phone's navbar, so
             the transcript reserves no band room; the composer's band it does. -->
        <div class="relative flex min-h-0 flex-1 flex-col" style={composerDock.columnStyle(true)}>
          <ConversationView {tabId} showActions={false} bandAbove={false} />
          <div
            bind:this={inputDockEl}
            class="guest-input-dock absolute inset-x-0 bottom-0 z-10 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))]"
            data-testid="guest-composer"
          >
            <EditorInputCard
              active
              tabId={tabId}
              class="mx-auto max-w-(--solus-reading-max)"
              readOnlyReason={composerReadOnlyReason}
              onAttachFile={() => attachFile(tabId)}
            />
            {#if role === "editor"}
              <p class="mx-auto max-w-(--solus-reading-max) pt-2 text-center text-[0.875em] text-(--solus-text-tertiary)" data-testid="guest-session-note">
                Prompts you send run on the account of the person who shared this link.
              </p>
            {/if}
          </div>
        </div>
      {:else}
        <!-- The shape of what is coming, in the column it will fill, so the
             page reads as loading rather than as empty. -->
        <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-1 flex-col gap-6 px-6 pt-10" role="status" aria-busy="true">
          <p class="text-(--solus-text-tertiary)">
            {share.resource.kind === "work" ? "Opening the document…" : share.resource.kind === "task" ? "Opening the task…" : "Opening the session…"}
          </p>
          <div class="flex flex-col gap-3">
            <Skeleton class="h-3.5 w-1/2" />
            <Skeleton class="h-3 w-full" />
            <Skeleton class="h-3 w-5/6" />
            <Skeleton class="h-3 w-2/3" />
          </div>
          <div class="flex flex-col gap-3">
            <Skeleton class="h-3 w-3/4" />
            <Skeleton class="h-3 w-full" />
            <Skeleton class="h-3 w-1/2" />
          </div>
        </div>
      {/if}
    </main>

    {#if railOpen}
      <div class="contents @max-[40rem]:hidden">
        <GuestRail
          {serverId}
          resource={share.resource}
          {resourceTitle}
          {role}
          {screenSessionId}
          sessions={taskSessions}
          {liveTitleFor}
          onOpenSession={(sessionId) => void openTaskSession(sessionId)}
          onOpenResource={() => void openShared()}
          resourceOnScreen={!!activeTaskRoute || !!activeWorkRoute || (share.resource.kind === "session" && hasTab)}
        />
      </div>
    {/if}
    </div>
  </div>

  {#if guestBoot.phase === "revoked"}
    <div class="fixed inset-0 z-[10008] grid place-items-center bg-[color-mix(in_srgb,var(--solus-modal-scrim)_70%,transparent)] px-6" role="alertdialog" aria-label="This link no longer works" data-testid="guest-revoked">
      <Empty.Root class="max-w-[24rem] flex-none border-solid border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[shadow:var(--solus-popover-shadow)]">
        <Empty.Header>
          <Empty.Media variant="icon"><LinkOffIcon /></Empty.Media>
          <Empty.Title>This link no longer works</Empty.Title>
          <Empty.Description>The person who shared it turned the link off or made a new one. Ask them for the current link.</Empty.Description>
        </Empty.Header>
      </Empty.Root>
    </div>
  {/if}
</Tooltip.Provider>

<style>
  /* The one pane a guest has. Every surface below reads its width from here,
     the same named container `WorkspaceBody` declares on `.primary-column`. */
  .guest-pane {
    container: pane / inline-size;
  }

  /* App chrome, not copy: a long-press on the band must not start a selection.
     The phone's notch pushes the band down by its own inset. */
  .guest-header {
    padding-top: env(safe-area-inset-top, 0px);
    box-sizing: content-box;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  /* The dock floats over the transcript, so it owns the background the rows
     end against; the rows scroll under it and dissolve at its edge
     (ConversationView's `.transcript-fade`), as under the workspace's dock. */
  .guest-input-dock {
    contain: layout paint;
    background: var(--solus-container-bg);
  }
</style>
