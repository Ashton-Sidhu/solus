<script lang="ts">
  import { onMount, untrack } from "svelte";
  import {
    CircleAlert as CircleAlertIcon,
    FileText as FileTextIcon,
    MessageSquare as MessageSquareIcon,
    PanelRight as PanelRightIcon,
    SquareCheck as SquareCheckIcon,
  } from "@lucide/svelte";
  import { setPopoverLayer } from "@solus/workspace-ui/components/popoverLayer.svelte";
  import { setupAgentEvents } from "@solus/workspace-ui/hooks/agentEvents.svelte";
  import { createAppCore } from "@solus/workspace-ui/contexts/app/app-core";
  import { visibleRef } from "@solus/workspace-ui/contexts/workspace/routing/location";
  import { serversStore } from "@solus/workspace-ui/contexts";
  import { connectionStatusLabel } from "@solus/client-core/connection-display";
  import { relativeTime } from "@solus/workspace-ui/lib/relative-time";
  import * as Tooltip from "@solus/workspace-ui/components/ui/tooltip";
  import * as Empty from "@solus/workspace-ui/components/ui/empty";
  import { Button } from "@solus/workspace-ui/components/ui/button";
  import { Skeleton } from "@solus/workspace-ui/components/ui/skeleton";
  import WorkspaceMark from "@solus/workspace-ui/components/ui/WorkspaceMark.svelte";
  import TasksPage from "@solus/workspace-ui/components/tasks/TasksPage.svelte";
  import TaskPage from "@solus/workspace-ui/components/tasks/task-page/TaskPage.svelte";
  import WorkPane from "@solus/workspace-ui/components/work/WorkPane.svelte";
  import SessionRecordPage from "@solus/workspace-ui/components/session/record/SessionRecordPage.svelte";
  import ShareDialog from "@solus/workspace-ui/components/sharing/ShareDialog.svelte";
  import { pageRouteFragment, pageRouteSection, parsePageRouteFragment, type PageRoute } from "./lib/page-routes";
  import { PageSessionRecords, sessionRecordTitle } from "./lib/page-session-records.svelte";
  import { webState } from "./lib/web-state.svelte";
  import { PageShell } from "./shell/page-shell.svelte";
  import PageRail from "./shell/PageRail.svelte";

  /**
   * One organization's pages on the account origin (docs/plans/cloud-service-model.md):
   * the task board, one task, the works list, one work, the session records, and
   * one session — against the organization's workspace service alone. The URL
   * hash is the location; the workspace router below it is kept in step so the
   * shared surfaces (the task page, the work pane, the record page) render as
   * they do in the workspace. There are no panes, no chat, and no host to run
   * anything on; "Open workspace" leads to the workspace bundle.
   */
  interface Props {
    serverId: string;
    organizationId: string;
    organizationName: string;
    /** Where the workspace bundle is mounted, e.g. `/app/`. */
    workspaceUrl: string;
  }
  let { serverId, organizationId, organizationName, workspaceUrl }: Props = $props();

  const shell = new PageShell(organizationId, workspaceUrl);
  const { settings, session } = createAppCore(shell);
  setupAgentEvents(session);
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

  // The hash is the location. A route the shell cannot read lands on the tasks.
  const home: PageRoute = { organizationId, page: "tasks" };
  let route = $state<PageRoute>(parsePageRouteFragment(window.location.hash) ?? home);
  onMount(() => {
    const read = () => {
      const next = parsePageRouteFragment(window.location.hash);
      route = next && next.organizationId === organizationId ? next : home;
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  });

  function go(next: PageRoute): void {
    window.location.hash = pageRouteFragment(next);
  }

  // The router follows the hash: the shared surfaces read their params from a
  // pane, so each page is placed there as the workspace would place it.
  $effect(() => {
    const current = route;
    untrack(() => {
      switch (current.page) {
        case "tasks":
          session.openTasks("click");
          return;
        case "task":
          session.openRoute({ name: "task", params: { taskId: current.taskId, serverId } });
          return;
        case "work":
          session.openRoute({ name: "work", params: { workId: current.workId, serverId } });
          return;
        case "session":
          session.openSessionRecord(current.sessionId, serverId);
          return;
        default:
          session.router.closeGroup("page");
          session.router.closeGroup("artifact");
      }
    });
  });

  const router = session.router;
  const activeRoute = $derived.by(() => {
    for (const pane of router.panes) {
      const ref = visibleRef(pane);
      if (ref?.name === "work") return { paneId: pane.id, kind: "work" as const, params: ref.params };
      if (ref?.name === "task") return { paneId: pane.id, kind: "task" as const, params: ref.params };
      if (ref?.name === "sessionRecord") return { paneId: pane.id, kind: "sessionRecord" as const, params: ref.params };
      if (ref?.name === "tasks") return { paneId: pane.id, kind: "tasks" as const, params: ref.params };
    }
    return null;
  });

  // The hash follows the router: a surface that opens a task or a work through
  // the workspace (the board opening a task, a task opening a work) lands on
  // that page's URL, so back and reload return to it.
  $effect(() => {
    const active = activeRoute;
    if (!active) return;
    const next: PageRoute | null =
      active.kind === "task" ? { organizationId, page: "task", taskId: active.params.taskId }
      : active.kind === "work" ? { organizationId, page: "work", workId: active.params.workId }
      : active.kind === "sessionRecord" ? { organizationId, page: "session", sessionId: active.params.sessionId }
      : null;
    if (!next) return;
    untrack(() => {
      if (pageRouteFragment(next) !== pageRouteFragment(route)) go(next);
    });
  });

  const section = $derived(pageRouteSection(route));

  // The lists the shell keeps itself: works on this host, and the session records.
  const sessionRecords = new PageSessionRecords(serverId);
  $effect(() => {
    if (route.page === "works") untrack(() => void session.worksStore.loadAll());
    if (route.page === "sessions") untrack(() => void sessionRecords.load());
  });
  const works = $derived(
    Object.values(session.worksStore.works)
      .filter((work) => session.worksStore.hostFor(work.id) === serverId && !session.worksStore.streaming[work.id])
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );

  const title = $derived.by(() => {
    switch (route.page) {
      case "tasks": return "Tasks";
      case "works": return "Works";
      case "sessions": return "Sessions";
      case "task": return session.tasksStore.peek(route.taskId)?.title ?? "Task";
      case "work": return session.worksStore.get(route.workId)?.title ?? "Document";
      case "session": return "Session";
    }
  });

  let railOpen = $state(!window.matchMedia("(pointer: coarse)").matches);
  const connectionLabel = $derived(
    connectionStatusLabel(webState.connectionStatus, {
      attempt: webState.connectionAttempt,
      hasConnected: webState.hasConnected,
    }),
  );
  const showConnectionStatus = $derived(webState.connectionStatus !== "connected");

  function openWorkspace(): void {
    shell.openResource({ kind: "workspace" });
  }
</script>

<svelte:head>
  <title>{title} · {organizationName} · Solus</title>
</svelte:head>

<Tooltip.Provider delayDuration={450} skipDelayDuration={300} disableHoverableContent>
  <div bind:this={overlayEl} data-solus-ui class="click-through-shell" style="position:fixed;inset:0;z-index:10010"></div>

  <div class="flex h-full w-full flex-col bg-(--background) text-workspace-chrome" data-solus-ui data-testid="page-shell" data-page={route.page}>
    <header
      class="page-header @container relative z-[3] flex h-[2.875rem] shrink-0 items-center gap-px border-b border-(--hairline) bg-(--background) pr-3 pl-3.5 pointer-coarse:h-14 pointer-coarse:pr-[max(0.75rem,env(safe-area-inset-right,0px))] pointer-coarse:pl-[max(0.875rem,env(safe-area-inset-left,0px))]"
    >
      <span class="flex shrink-0 items-center gap-[0.4375rem] pr-1 font-medium tracking-[-0.01em] text-(--solus-text-primary)">
        <WorkspaceMark class="size-[1.125rem] shrink-0" />
        <span class="max-[28rem]:sr-only">Solus Cloud</span>
      </span>
      <span class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30 max-[28rem]:hidden" aria-hidden="true">/</span>
      <span class="flex h-[1.875rem] min-w-0 shrink items-center gap-1.5 px-1.5 text-muted-foreground max-[28rem]:hidden">
        <span class="truncate">{organizationName}</span>
      </span>
      <span class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30 max-[28rem]:hidden" aria-hidden="true">/</span>
      <span class="flex h-[1.875rem] min-w-0 shrink items-center gap-1.5 px-1.5">
        {#if section === "works"}
          <FileTextIcon size={14} class="shrink-0 text-muted-foreground" />
        {:else if section === "sessions"}
          <MessageSquareIcon size={14} class="shrink-0 text-muted-foreground" />
        {:else}
          <SquareCheckIcon size={14} class="shrink-0 text-muted-foreground" />
        {/if}
        <span class="truncate font-medium text-(--solus-text-primary)" data-testid="page-title">{title}</span>
      </span>

      <span class="min-w-2 flex-1" aria-hidden="true"></span>

      {#if showConnectionStatus}
        <span class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-(--solus-surface-hover) px-2 text-[0.875em] tabular-nums text-(--solus-text-tertiary)" data-testid="page-connection">
          <span class="size-1.5 rounded-full bg-(--solus-accent)" class:animate-pulse={webState.connectionStatus === "connecting" || webState.connectionStatus === "reconnecting"}></span>
          <span class="max-w-[9rem] truncate">{connectionLabel}</span>
        </span>
      {/if}

      <button
        type="button"
        class="ml-1 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground @max-[40rem]:hidden pointer-coarse:size-9 {railOpen ? 'bg-accent text-foreground' : ''}"
        title={railOpen ? "Hide the panel" : "Show the panel"}
        aria-label={railOpen ? "Hide the panel" : "Show the panel"}
        aria-pressed={railOpen}
        data-testid="page-rail-toggle"
        onclick={() => (railOpen = !railOpen)}
      >
        <PanelRightIcon size={14} />
      </button>
    </header>

    <!-- A phone has the strip under the band; a wide window has the rail beside the page. -->
    <div class="page-row @container flex min-h-0 flex-1 flex-col">
      <div class="contents @min-[40rem]:hidden">
        <PageRail {organizationId} {organizationName} {section} variant="strip" onOpenWorkspace={openWorkspace} />
      </div>
      <div class="flex min-h-0 flex-1">
        <main class="page-pane relative flex min-h-0 flex-1 flex-col" data-testid="page-main">
          {#if route.page === "works"}
            <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-1 flex-col gap-1 overflow-y-auto px-4 pt-6" data-testid="page-works">
              {#if session.worksStore.listLoading && works.length === 0}
                <Skeleton class="h-3.5 w-1/2" />
                <Skeleton class="mt-2 h-3 w-full" />
              {:else if works.length === 0}
                <Empty.Root class="max-w-[26rem] flex-none border">
                  <Empty.Header>
                    <Empty.Media variant="icon"><FileTextIcon /></Empty.Media>
                    <Empty.Title>No documents here yet</Empty.Title>
                    <Empty.Description>Move a document to Solus Cloud from the workspace and it appears here for everyone in {organizationName}.</Empty.Description>
                  </Empty.Header>
                </Empty.Root>
              {:else}
                {#each works as work (work.id)}
                  <button
                    type="button"
                    class="flex min-h-11 w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg px-2 text-left transition-[background] duration-150 hover:bg-(--solus-surface-hover) pointer-coarse:min-h-12"
                    data-testid="page-work-row"
                    onclick={() => go({ organizationId, page: "work", workId: work.id })}
                  >
                    <FileTextIcon size={14} class="shrink-0 text-muted-foreground" />
                    <span class="flex min-w-0 flex-1 flex-col leading-tight">
                      <span class="truncate text-(--solus-text-primary)">{work.title || "Untitled"}</span>
                      <span class="truncate text-[0.875em] text-(--solus-text-tertiary)">{work.type} · {relativeTime(Date.parse(work.updatedAt))}</span>
                    </span>
                  </button>
                {/each}
              {/if}
            </div>
          {:else if route.page === "sessions"}
            <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-1 flex-col gap-1 overflow-y-auto px-4 pt-6" data-testid="page-sessions">
              {#if sessionRecords.error}
                <Empty.Root class="max-w-[26rem] flex-none border">
                  <Empty.Header>
                    <Empty.Media variant="icon"><CircleAlertIcon /></Empty.Media>
                    <Empty.Title>Couldn’t read the sessions</Empty.Title>
                    <Empty.Description>{sessionRecords.error}</Empty.Description>
                  </Empty.Header>
                  <Empty.Content>
                    <Button variant="outline" onclick={() => void sessionRecords.load()}>Try again</Button>
                  </Empty.Content>
                </Empty.Root>
              {:else if sessionRecords.loading && sessionRecords.records.length === 0}
                <Skeleton class="h-3.5 w-1/2" />
                <Skeleton class="mt-2 h-3 w-full" />
              {:else if sessionRecords.records.length === 0}
                <Empty.Root class="max-w-[26rem] flex-none border">
                  <Empty.Header>
                    <Empty.Media variant="icon"><MessageSquareIcon /></Empty.Media>
                    <Empty.Title>No sessions recorded yet</Empty.Title>
                    <Empty.Description>A session run on a machine linked to {organizationName} is recorded here.</Empty.Description>
                  </Empty.Header>
                </Empty.Root>
              {:else}
                {#each sessionRecords.records as record (record.sessionId)}
                  <button
                    type="button"
                    class="flex min-h-11 w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg px-2 text-left transition-[background] duration-150 hover:bg-(--solus-surface-hover) pointer-coarse:min-h-12"
                    data-testid="page-session-row"
                    onclick={() => go({ organizationId, page: "session", sessionId: record.sessionId })}
                  >
                    <MessageSquareIcon size={14} class="shrink-0 text-muted-foreground" />
                    <span class="flex min-w-0 flex-1 flex-col leading-tight">
                      <span class="truncate text-(--solus-text-primary)">{sessionRecordTitle(record)}</span>
                      <span class="truncate font-mono text-[0.8125em] text-(--solus-text-tertiary)">{record.provider} · {record.status} · {relativeTime(record.lastActivityAt)}</span>
                    </span>
                  </button>
                {/each}
              {/if}
            </div>
          {:else if activeRoute?.kind === "work"}
            <div class="flex min-h-0 flex-1 flex-col">
              <WorkPane params={activeRoute.params} paneId={activeRoute.paneId} />
            </div>
          {:else if activeRoute?.kind === "task"}
            <div class="flex min-h-0 flex-1 flex-col" data-testid="page-task">
              <TaskPage params={activeRoute.params} paneId={activeRoute.paneId} onRequestClose={() => go({ organizationId, page: "tasks" })} />
            </div>
          {:else if activeRoute?.kind === "sessionRecord"}
            <div class="flex min-h-0 flex-1 flex-col" data-testid="page-session">
              <SessionRecordPage params={activeRoute.params} paneId={activeRoute.paneId} />
            </div>
          {:else if activeRoute?.kind === "tasks"}
            <div class="flex min-h-0 flex-1 flex-col" data-testid="page-tasks">
              <TasksPage paneId={activeRoute.paneId} />
            </div>
          {:else}
            <div class="mx-auto flex w-full max-w-(--solus-reading-max) flex-1 flex-col gap-3 px-6 pt-10" role="status" aria-busy="true">
              <Skeleton class="h-3.5 w-1/2" />
              <Skeleton class="h-3 w-full" />
              <Skeleton class="h-3 w-2/3" />
            </div>
          {/if}
        </main>
        {#if railOpen}
          <div class="contents @max-[40rem]:hidden">
            <PageRail {organizationId} {organizationName} {section} variant="side" onOpenWorkspace={openWorkspace} />
          </div>
        {/if}
      </div>
    </div>
  </div>
  <ShareDialog />
</Tooltip.Provider>

<style>
  /* The one pane these pages have: every surface reads its width from here,
     the named container `WorkspaceBody` declares on `.primary-column`. */
  .page-pane {
    container: pane / inline-size;
  }

  .page-header {
    padding-top: env(safe-area-inset-top, 0px);
    box-sizing: content-box;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
</style>
