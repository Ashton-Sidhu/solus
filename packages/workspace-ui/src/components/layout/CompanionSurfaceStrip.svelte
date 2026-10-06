<script lang="ts">
  import {
    Bot as SubagentIcon,
    ClipboardList as TaskIcon,
    FileDiff as DiffIcon,
    FileText as DocumentIcon,
    FolderTree as FilesIcon,
    GitPullRequest as PullRequestIcon,
    Globe as BrowserIcon,
    ListChecks as PlanIcon,
    Maximize as MaximizeIcon,
    MessageSquare as ChatIcon,
    Minimize as RestoreIcon,
    PanelRightClose as HidePaneIcon,
    Smartphone as DevicesIcon,
    Target as GoalIcon,
    Workflow as AutomationIcon,
    Plus as PlusIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext } from "../../contexts";
  import type { PaneEntry } from "../../contexts/workspace/routing/location";
  import { ROUTES, surfaceKey, type RouteRef } from "../../contexts/workspace/routing/route-registry";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { comboHint } from "../../lib/keybindings/manifest";
  import * as TooltipUI from "../ui/tooltip";
  import * as ContextMenu from "../ui/context-menu";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { surfaceLabel, type SurfaceTitleSources } from "./lib/surface-labels";

  /**
   * The companion pane's strip: one tab per surface the destination opened
   * beside it (docs/plans/companion-surfaces.md). Shown whenever the
   * companion pane is open, so one surface already reads as a tab. It is the
   * pane's header: maximize and hide sit at its end, and the surfaces under it
   * draw no cluster of their own (`underStrip`).
   */
  interface Props {
    pane: PaneEntry;
  }
  let { pane }: Props = $props();

  const session = getWorkspaceContext();
  const router = session.router;

  // Every route has a glyph, so a lookup never falls through. A destination
  // never sits in the strip; it takes the generic one.
  const ICONS = {
    chat: ChatIcon,
    draft: ChatIcon,
    sessionRecord: ChatIcon,
    task: TaskIcon,
    work: DocumentIcon,
    plan: PlanIcon,
    automation: AutomationIcon,
    review: DiffIcon,
    files: FilesIcon,
    subagent: SubagentIcon,
    browser: BrowserIcon,
    devices: DevicesIcon,
    goal: GoalIcon,
    prReview: PullRequestIcon,
    prDiff: PullRequestIcon,
    tasks: DocumentIcon,
    prs: DocumentIcon,
    insights: DocumentIcon,
    reviewMode: DocumentIcon,
    settings: DocumentIcon,
    folio: DocumentIcon,
    automations: DocumentIcon,
    notifications: DocumentIcon,
  } satisfies { [Name in RouteRef["name"]]: typeof ChatIcon };

  const titles: SurfaceTitleSources = {
    sessionTitle: (sessionId) => session.sessions.byId[sessionId]?.title,
    taskTitle: (taskId) => session.tasksStore.peek(taskId)?.title,
    workTitle: (workId) => session.worksStore.get(workId)?.title,
    planTitle: (planId) => session.planStore.get(planId)?.title,
    automationName: (automationId) => session.automationsStore.get(automationId)?.name,
  };

  let menu = $state<{ index: number; x: number; y: number } | null>(null);
  // A page paints its own background up to the pane's top edge, so the strip
  // over it takes the same one rather than the framed pane's stepped-back tone.
  const activeIsPage = $derived(
    ROUTES[pane.surfaces[pane.activeSurfaceIndex]?.name ?? "chat"].ownsTitlebarChrome === true,
  );

  // What the "+" menu opens beside: the leading conversation, or the draft it
  // is composing. Its changes and files are what a new tab shows.
  const leadingSourceId = $derived(
    router.destination.name === "draft" ? router.destination.params.draftId : session.activeTabId,
  );
  const canOpenChanges = $derived(
    router.destination.name === "chat" && !!session.sessionFor(session.activeTabId)?.run.workingDirectory,
  );
  const canOpenFiles = $derived(!!leadingSourceId && !!session.runFor(leadingSourceId));

  function openChanges() {
    session.showDiff(session.activeTabId);
  }

  function openFiles() {
    session.openFiles(leadingSourceId);
  }

  function openNewSession() {
    session.drafts.openSessionDraft({ target: "companion", via: "click" });
    requestInputFocus();
  }
  let stripEl: HTMLDivElement | undefined = $state();

  // The active tab stays in view when the strip scrolls.
  $effect(() => {
    const index = pane.activeSurfaceIndex;
    const tab = stripEl?.querySelector<HTMLElement>(`[data-surface-index="${index}"]`);
    tab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  function select(index: number) {
    router.activateSurface(index);
  }

  function close(index: number) {
    router.closeSurface(index);
    requestInputFocus();
  }

  /** A conversation or a draft can lead; the other surfaces cannot. */
  function canMoveToMain(ref: RouteRef): boolean {
    return ROUTES[ref.name].placement === "either";
  }

  function moveToMain(index: number) {
    const ref = pane.surfaces[index];
    if (!ref) return;
    if (ref.name === "chat") {
      router.activateSurface(index);
      session.moveChatSurfaceToMain();
      return;
    }
    router.moveSurfaceToMain(index);
    requestInputFocus();
  }

  function onAuxClick(event: MouseEvent, index: number) {
    if (event.button !== 1) return;
    event.preventDefault();
    close(index);
  }

  function onContextMenu(event: MouseEvent, index: number) {
    event.preventDefault();
    menu = { index, x: event.clientX, y: event.clientY };
  }

  /** Arrow keys move between tabs; the focused tab is the active one. */
  function onKeydown(event: KeyboardEvent) {
    const count = pane.surfaces.length;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (pane.activeSurfaceIndex + 1) % count;
    else if (event.key === "ArrowLeft") next = (pane.activeSurfaceIndex - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null) return;
    event.preventDefault();
    select(next);
    stripEl?.querySelector<HTMLElement>(`[data-surface-index="${next}"]`)?.focus();
  }

  const maximized = $derived(session.maximizedPaneId === pane.id);
  const maximizeHint = $derived(comboHint("pane.maximize"));
  const hideHint = $derived(comboHint("pane.close"));

  function toggleMaximize() {
    session.maximizedPaneId = maximized ? null : pane.id;
  }

  /** Hide the pane and keep its tabs; the open-in-split key brings them back. */
  function hidePane() {
    router.hideCompanion();
    requestInputFocus();
  }

  function runMenuAction(action: () => void) {
    menu = null;
    action();
  }
</script>

<div
  class="no-drag flex h-(--solus-chrome-row-h,2.5rem) shrink-0 items-center gap-1 pr-2.5 pl-[max(0.5rem,var(--solus-chrome-lead-inset,0px))] pointer-coarse:h-12 {activeIsPage
    ? 'bg-background'
    : ''}"
>
<div
  bind:this={stripEl}
  class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:h-0"
  role="tablist"
  aria-label="Surfaces beside this page"
  tabindex="-1"
  onkeydown={onKeydown}
>
  {#each pane.surfaces as surface, index (surfaceKey(surface))}
    {@const isActive = index === pane.activeSurfaceIndex}
    {@const Icon = ICONS[surface.name]}
    {@const label = surfaceLabel(surface, titles)}
    <!-- One pill per surface: the glyph doubles as its close button, which
         shows an × while the pointer is over the tab. -->
    <div
      class="group/tab flex h-7 max-w-44 min-w-0 shrink-0 cursor-pointer items-center gap-1 rounded-md pr-2 pl-1.5 text-workspace-chrome pointer-coarse:h-9 {isActive
        ? 'bg-accent text-foreground'
        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'}"
      onauxclick={(event) => onAuxClick(event, index)}
      oncontextmenu={(event) => onContextMenu(event, index)}
    >
      <button
        type="button"
        tabindex="-1"
        aria-label={`Close ${label}`}
        class="group/close relative flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-inherit hover:bg-muted pointer-coarse:size-6"
        onclick={() => close(index)}
      >
        <span class="relative flex size-4 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden">
          <Icon size={14} strokeWidth={1.5} />
          {#if router.isSurfaceUnread(surface)}
            <span class="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-(--primary)" aria-label="New"></span>
          {/if}
        </span>
        <XIcon size={14} strokeWidth={1.5} class="hidden group-hover/tab:block group-focus-visible/close:block" />
      </button>
      <button
        type="button"
        role="tab"
        data-surface-index={index}
        aria-selected={isActive}
        tabindex={isActive ? 0 : -1}
        title={label}
        class="flex min-w-0 cursor-pointer items-center overflow-hidden border-0 bg-transparent p-0 text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
        onclick={() => select(index)}
      >
        <span class="truncate">{label}</span>
      </button>
    </div>
  {/each}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          aria-label="Open a new tab"
          title="Open a new tab"
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-9"
        >
          <PlusIcon size={14} strokeWidth={1.5} />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="min-w-44">
      <DropdownMenu.Item disabled={!canOpenChanges} onSelect={openChanges}>
        <DiffIcon size={16} strokeWidth={1.5} />
        Changes
      </DropdownMenu.Item>
      <DropdownMenu.Item disabled={!canOpenFiles} onSelect={openFiles}>
        <FilesIcon size={16} strokeWidth={1.5} />
        Files
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={() => session.openBrowser()}>
        <BrowserIcon size={16} strokeWidth={1.5} />
        Browser
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={() => session.openDevices(undefined, undefined, { newTab: true })}>
        <DevicesIcon size={16} strokeWidth={1.5} />
        Devices
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={openNewSession}>
        <ChatIcon size={16} strokeWidth={1.5} />
        New session
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
  <!-- Outside the scroller, so they stay put however many tabs are open. -->
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          aria-label={maximized ? "Restore panel size" : "Maximize panel"}
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-9"
          onclick={toggleMaximize}
        >
          {#if maximized}
            <RestoreIcon size={14} strokeWidth={1.5} />
          {:else}
            <MaximizeIcon size={14} strokeWidth={1.5} />
          {/if}
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content
      value={`${maximized ? "Restore panel" : "Maximize"}${maximizeHint ? ` (${maximizeHint})` : ""}`}
    />
  </TooltipUI.Root>
  <TooltipUI.Root>
    <TooltipUI.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          aria-label="Hide pane"
          class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)] pointer-coarse:size-9"
          onclick={hidePane}
        >
          <HidePaneIcon size={14} strokeWidth={1.5} />
        </button>
      {/snippet}
    </TooltipUI.Trigger>
    <TooltipUI.Content value={`Hide pane${hideHint ? ` (${hideHint})` : ""}`} />
  </TooltipUI.Root>
</div>

{#if menu}
  {@const target = menu}
  {@const targetRef = pane.surfaces[target.index]}
  <ContextMenu.Root onOpenChange={(open) => { if (!open) menu = null; }}>
    <ContextMenu.PointTrigger x={target.x} y={target.y} />
    <ContextMenu.Content class="min-w-44">
      <ContextMenu.Item onSelect={() => runMenuAction(() => close(target.index))}>Close</ContextMenu.Item>
      <ContextMenu.Item
        disabled={pane.surfaces.length < 2}
        onSelect={() => runMenuAction(() => router.closeOtherSurfaces(target.index))}
      >
        Close Others
      </ContextMenu.Item>
      <ContextMenu.Item
        disabled={target.index >= pane.surfaces.length - 1}
        onSelect={() => runMenuAction(() => router.closeSurfacesToRight(target.index))}
      >
        Close to the Right
      </ContextMenu.Item>
      {#if targetRef && canMoveToMain(targetRef)}
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={() => runMenuAction(() => moveToMain(target.index))}>
          Move to Main
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{/if}
