<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import {
    PlusIcon,
    BooksIcon,
    GearIcon,
    ClockIcon,
    CheckIcon,
    XIcon,
    PushPinIcon,
    CaretRightIcon,
    HardDrivesIcon,
    BookOpenTextIcon,
    CircleNotchIcon,
    NotePencilIcon,
    PaperclipIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, getSessionSidebarStore, serversStore } from "@renderer/contexts";
  import { aggregateReviewGuideStatus } from "@renderer/components/session/lib/task-list";
  import { toasts } from "@renderer/lib/toasts";
  import { requestInputFocus } from "@renderer/lib/inputFocus";
  import { getAttentionIcon, attentionLabel, type AttentionState } from "@renderer/lib/sessionUtils";
  import { Skeleton } from "@renderer/components/ui/skeleton";

  interface Props {
    /** Close the drawer after a navigation action. */
    onSessionSelect: () => void;
    /** Open the server sheet (closing the drawer first). */
    onOpenServers: () => void;
  }
  let { onSessionSelect, onOpenServers }: Props = $props();

  const session = getWorkspaceContext();
  const store = getSessionSidebarStore();

  const activeServer = $derived(serversStore.activeServer);
  const serverOnline = $derived(activeServer?.status === "online");

  // Keep the phone surface flat, but source its rows from the same durable
  // task tree as desktop. Sessions become peer-sized tap targets rather than a
  // nested disclosure, and unopened attempts remain lazy until selected.
  const groups = $derived(store.taskGroups);
  const hasSessions = $derived(groups.length > 0);
  const collapsedProjectKeys = new SvelteSet<string>();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Shared row shell — keeps pinned + session rows visually identical.
  const rowBase =
    "group relative flex items-center gap-2.5 w-full min-h-[3.25rem] py-2 pr-1.5 pl-3.5 rounded-lg text-left cursor-pointer [-webkit-tap-highlight-color:transparent] transition-colors duration-100";
  const sectionLabel =
    "first:pt-2 px-3.5 pt-[1.125rem] pb-1 text-[0.75rem] font-normal text-(--solus-text-tertiary) truncate";

  function toggleProject(projectKey: string) {
    if (collapsedProjectKeys.has(projectKey)) {
      collapsedProjectKeys.delete(projectKey);
    } else {
      collapsedProjectKeys.add(projectKey);
    }
  }

  function projectGroupId(projectKey: string) {
    return `mobile-project-${encodeURIComponent(projectKey)}`;
  }

  // Fixed widths, so the loading list never reshuffles between renders.
  const SKELETON_ROWS = [
    { width: "62%", delay: 0 },
    { width: "44%", delay: 80 },
    { width: "71%", delay: 160 },
    { width: "38%", delay: 240 },
    { width: "55%", delay: 320 },
  ];

  function selectTask(task: (typeof store.allTasks)[number]) {
    void store.selectTask(task);
    requestInputFocus();
    onSessionSelect();
  }

  function selectSession(child: ReturnType<typeof store.sessionsFor>[number]) {
    void store.selectChild(child);
    requestInputFocus();
    onSessionSelect();
  }

  function removeTask(task: (typeof store.allTasks)[number], e: Event) {
    e.stopPropagation();
    if (task.status === "running") {
      const running = task.tabIds.filter(
        (tabId) => store.childForTab(tabId).attention === "running",
      ).length;
      toasts.show({
        message: `Stop ${running === 1 ? "the run" : `${running} runs`} in “${task.title}” and remove it from the sidebar?`,
        actions: [
          { label: "Stop and remove", onAction: () => store.closeTask(task) },
          { label: "Keep open", onAction: requestInputFocus },
        ],
      });
      return;
    }
    store.closeTask(task);
  }

  /** The group-level twin of `removeTask`: the whole section leaves the list.
   *  Runs in flight are the one thing that cannot come back as they were, so a
   *  project holding any asks first. */
  function removeProject(group: (typeof groups)[number], e: Event) {
    e.stopPropagation();
    const running = store.runningTaskCountIn(group.projectKey);
    if (running > 0) {
      toasts.show({
        message: `Stop ${running === 1 ? "the run" : `${running} runs`} in “${group.projectLabel}” and remove its tasks from the sidebar?`,
        actions: [
          { label: "Stop and remove", onAction: () => store.closeProject(group.projectKey) },
          { label: "Keep open", onAction: requestInputFocus },
        ],
      });
      return;
    }
    store.closeProject(group.projectKey);
  }

  async function finishTask(task: (typeof store.allTasks)[number]) {
    try {
      if (task.taskId) await session.tasksStore.setStatus(task.taskId, "done");
      store.closeTask(task);
    } catch (error) {
      toasts.error(
        `Couldn't complete task: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function completeTask(task: (typeof store.allTasks)[number], e: Event) {
    e.stopPropagation();
    if (task.status !== "running") {
      void finishTask(task);
      return;
    }
    toasts.show({
      message: `Stop the work in “${task.title}” and mark it completed?`,
      actions: [
        { label: "Stop and complete", onAction: () => void finishTask(task) },
        { label: "Keep working", onAction: requestInputFocus },
      ],
    });
  }

  function removeChild(
    child: ReturnType<typeof store.sessionsFor>[number],
    e: Event,
  ) {
    e.stopPropagation();
    const remove = () => store.closeChild(child);
    if (child.attention !== "running") {
      remove();
      return;
    }
    toasts.show({
      message: `Stop “${child.label}” and remove it from the sidebar?`,
      actions: [
        { label: "Stop and remove", onAction: remove },
        { label: "Keep open", onAction: requestInputFocus },
      ],
    });
  }

  async function finishChild(child: ReturnType<typeof store.sessionsFor>[number]) {
    try {
      if (child.taskId) await session.tasksStore.setStatus(child.taskId, "done");
      store.closeChild(child);
    } catch (error) {
      toasts.error(
        `Couldn't complete subtask: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function completeChild(
    child: ReturnType<typeof store.sessionsFor>[number],
    e: Event,
  ) {
    e.stopPropagation();
    if (child.attention !== "running") {
      void finishChild(child);
      return;
    }
    toasts.show({
      message: `Stop “${child.label}” and mark the subtask completed?`,
      actions: [
        { label: "Stop and complete", onAction: () => void finishChild(child) },
        { label: "Keep working", onAction: requestInputFocus },
      ],
    });
  }

  /** Same two actions the desktop drafts section has: go back to the composer,
   *  or discard with the words held in a toast until it is dismissed. */
  function openDraft(draftId: string) {
    session.openDraft(draftId);
    requestInputFocus();
    onSessionSelect();
  }

  function discardDraft(row: (typeof store.draftRows)[number], e: Event) {
    e.stopPropagation();
    const discarded = session.discardSessionDraft(row.draftId);
    if (!discarded) return;
    toasts.show({
      message: `Discarded “${row.title}”`,
      actions: [
        {
          label: "Undo",
          onAction: () =>
            session.restoreSessionDrafts({
              order: [row.draftId],
              drafts: { [row.draftId]: discarded },
            }),
        },
      ],
    });
  }

  function newSession() {
    session.openSessionDraft({ via: "click" });
    requestInputFocus();
    onSessionSelect();
  }

  function nav(action: () => void) {
    action();
    onSessionSelect();
  }

  function reviewStatusForTab(tabId: string | null | undefined) {
    return tabId ? store.childForTab(tabId).reviewGuideStatus : null;
  }
</script>

{#snippet attentionMark(att: AttentionState)}
  {#if att === "unread"}
    <span class="shrink-0 w-2 h-2 rounded-full bg-(--solus-accent)" aria-label="unread"></span>
  {:else}
    {@const icon = getAttentionIcon(att)}
    {#if icon}
      {@const Icon = icon.component}
      <span
        class="shrink-0 flex items-center {icon.spin ? 'animate-spin' : ''}"
        style="color:{icon.color}"
        aria-label={attentionLabel(att) || undefined}
      >
        <Icon size={13} weight="bold" />
      </span>
    {/if}
  {/if}
{/snippet}

{#snippet reviewMark(status: "generating" | "ready")}
  <span
    class="shrink-0 flex items-center {status === 'ready'
      ? 'text-(--solus-art-positive)'
      : 'text-(--solus-status-running-icon)'}"
    title={status === "ready" ? "Review guide ready" : "Generating review guide"}
    aria-label={status === "ready" ? "Review guide ready" : "Generating review guide"}
  >
    {#if status === "ready"}
      <BookOpenTextIcon size={14} weight="fill" />
    {:else}
      <CircleNotchIcon
        size={14}
        class="animate-spin [animation-duration:0.9s] motion-reduce:animate-none"
      />
    {/if}
  </span>
{/snippet}

{#snippet activeBar()}
  <span class="absolute left-1 top-1/2 -translate-y-1/2 h-5 w-[0.1875rem] rounded-full bg-(--solus-accent)"></span>
{/snippet}

<div class="flex flex-col h-full min-h-0">
  <header
    class="shrink-0 flex flex-col px-4 pb-2 pt-[max(0.875rem,env(safe-area-inset-top,0px))]"
  >
    <div class="flex items-center justify-between">
      <span class="text-[1.125rem] font-medium tracking-[-0.01em] text-(--solus-text-primary)">Sessions</span>
      <button
        class="flex items-center gap-1 rounded-full border-0 bg-(--solus-accent-light) py-1.5 pl-2.5 pr-3 text-[0.8125rem] font-medium text-(--solus-accent) cursor-pointer transition-[background-color,transform] duration-[120ms] active:scale-[0.96] active:bg-(--solus-accent-border-medium) [-webkit-tap-highlight-color:transparent]"
        onclick={newSession}
        aria-label="New session"
      >
        <PlusIcon size={17} weight="bold" />
        <span>New</span>
      </button>
    </div>
    {#if activeServer}
      <button
        class="mt-2 flex items-center gap-2 rounded-lg border-0 bg-(--solus-surface-hover) px-2.5 py-2 text-left cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-active) [-webkit-tap-highlight-color:transparent]"
        onclick={() => nav(onOpenServers)}
        aria-label="Servers"
      >
        <HardDrivesIcon size={15} class="shrink-0 text-(--solus-text-tertiary)" />
        <span class="flex-1 min-w-0 truncate text-[0.75rem] font-medium text-(--solus-text-secondary)">{activeServer.label}</span>
        <span
          class="shrink-0 w-1.5 h-1.5 rounded-full {serverOnline ? 'bg-(--solus-status-complete)' : 'bg-(--solus-text-quaternary) opacity-60'}"
          aria-hidden="true"
        ></span>
        <CaretRightIcon size={12} class="shrink-0 text-(--solus-text-quaternary)" />
      </button>
    {/if}
  </header>

  <div class="flex-1 min-h-0 overflow-y-auto overscroll-y-contain px-2 pt-0.5 pb-3 [-webkit-overflow-scrolling:touch]">
    <!-- Prompts written but never sent, above the sessions they are on their way
         to becoming. Empty drafts earn no row, so the section is absent until
         something is written. -->
    {#if store.draftRows.length > 0}
      <div class={sectionLabel}>Drafts</div>
      {#each store.draftRows as row (row.draftId)}
        <!-- No active state: a draft is listed only once no pane is composing
             it, so a row here is never the prompt on screen. -->
        <div
          class="{rowBase} bg-transparent active:bg-(--solus-surface-hover)"
          role="button"
          tabindex="0"
          onclick={() => openDraft(row.draftId)}
          onkeydown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            openDraft(row.draftId);
          }}
        >
          <span class="shrink-0 flex items-center text-(--solus-text-tertiary)"><NotePencilIcon size={14} /></span>
          <span class="flex-1 min-w-0 flex flex-col gap-px">
            <span class="truncate text-[0.8125rem] leading-tight font-normal text-(--solus-text-primary)">{row.title}</span>
            <span class="truncate text-[0.6875rem] leading-tight text-(--solus-text-tertiary)">{row.projectLabel}</span>
          </span>
          {#if row.hasAttachments}
            <span class="shrink-0 flex items-center text-(--solus-text-tertiary)" aria-label="Has attachments"><PaperclipIcon size={13} /></span>
          {/if}
          <button
            class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
            aria-label="Discard draft"
            onclick={(e) => discardDraft(row, e)}
          >
            <XIcon size={15} />
          </button>
        </div>
      {/each}
    {/if}

    {#if store.pinnedSessions.length > 0}
      <div class={sectionLabel}>Pinned</div>
      {#each store.pinnedSessions as pin (`${pin.serverId ?? ""}:${pin.sessionId}`)}
        {@const openTabId = store.openTabIdForPinned(pin)}
        {@const isActive = !!openTabId && openTabId === session.onScreenTabId}
        {@const reviewStatus = reviewStatusForTab(openTabId)}
        <button
          class="{rowBase} {isActive ? 'bg-(--solus-accent-light)' : 'bg-transparent active:bg-(--solus-surface-hover)'}"
          onclick={() => nav(() => store.openPinnedSession(pin))}
        >
          {#if isActive}{@render activeBar()}{/if}
          <span class="shrink-0 flex items-center {isActive ? 'text-(--solus-accent)' : 'text-(--solus-text-tertiary)'}"><PushPinIcon size={14} weight="fill" /></span>
          <span class="flex-1 min-w-0 truncate text-[0.8125rem] font-normal {isActive ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{pin.title}</span>
          {#if reviewStatus}
            {@render reviewMark(reviewStatus)}
          {/if}
        </button>
      {/each}
    {/if}

    {#if !session.tasksStore.loaded}
      <!-- Placeholders sit on the same rhythm as the rows they stand in for —
           section label, leading mark, one title line — so the list settles in
           place rather than reflowing when it arrives. -->
      <div class="flex flex-col" role="status" aria-label="Loading sessions">
        <div class="{sectionLabel} flex items-end">
          <Skeleton class="h-2 w-[28%] rounded-[0.1875rem] opacity-70" />
        </div>
        {#each SKELETON_ROWS as row, i (i)}
          <div
            class="flex min-h-[3.25rem] items-center gap-2.5 py-2 pr-1.5 pl-3.5"
            style="opacity:{1 - i * 0.13}"
          >
            <Skeleton class="size-[0.875rem] shrink-0 rounded-full opacity-60" />
            <Skeleton
              class="h-[0.75rem] rounded-[0.25rem]"
              style="width:{row.width};animation-delay:{row.delay}ms"
            />
          </div>
        {/each}
      </div>
    {:else if hasSessions}
      {#each groups as group (group.projectKey)}
        <!-- A phone has no hover, so the project's close sits in the heading
             beside its count at the same tap size as a task's own remove. -->
        <div
          role="button"
          tabindex="0"
          class="{sectionLabel} flex min-h-10 w-full cursor-pointer items-center gap-2 text-left [-webkit-tap-highlight-color:transparent] active:bg-(--solus-surface-hover)"
          aria-expanded={!collapsedProjectKeys.has(group.projectKey)}
          aria-controls={projectGroupId(group.projectKey)}
          onclick={() => toggleProject(group.projectKey)}
          onkeydown={(e) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            toggleProject(group.projectKey);
          }}
        >
          <span class="min-w-0 flex-1 truncate">{group.projectLabel}</span>
          <span class="font-mono text-[0.6875rem] opacity-60 tabular-nums">{group.tasks.length}</span>
          <button
            class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
            aria-label="Close {group.projectLabel} and remove its tasks from the sidebar"
            onclick={(e) => removeProject(group, e)}
          >
            <XIcon size={15} />
          </button>
          <CaretRightIcon
            size={12}
            class="shrink-0 transition-transform duration-150 {collapsedProjectKeys.has(
              group.projectKey,
            )
              ? ''
              : 'rotate-90'}"
          />
        </div>
        {#if !collapsedProjectKeys.has(group.projectKey)}
          <div
            id={projectGroupId(group.projectKey)}
            transition:slide={{ duration: reduceMotion ? 0 : 120, easing: cubicOut }}
          >
            {#each group.tasks as task (task.id)}
              {@const taskSessions = task.taskId ? store.sessionsFor(task) : []}
              {@const isActive = task.tabIds.includes(session.onScreenTabId)}
              {@const leadTabId = task.tabIds[0]}
              {@const reviewStatus = aggregateReviewGuideStatus(
                taskSessions.length > 0
                  ? taskSessions
                  : leadTabId
                    ? [store.childForTab(leadTabId)]
                    : [],
              )}
              <div
            class="{rowBase} {isActive ? 'bg-(--solus-accent-light)' : 'bg-transparent active:bg-(--solus-surface-hover)'}"
            role="button"
            tabindex="0"
            data-active={isActive ? "true" : undefined}
            onclick={() => selectTask(task)}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                selectTask(task);
              }
            }}
          >
            {#if isActive}{@render activeBar()}{/if}
            <span class="flex-1 min-w-0 flex flex-col gap-px">
              <span class="truncate text-[0.8125rem] leading-tight font-normal {isActive ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{task.title}</span>
              {#if taskSessions.length > 0}
                <span class="truncate text-[0.6875rem] leading-tight text-(--solus-text-tertiary)">{taskSessions.length} session{taskSessions.length === 1 ? '' : 's'}</span>
              {/if}
            </span>
            {#if task.attention}
              {@render attentionMark(task.attention)}
            {/if}
            {#if reviewStatus}
              {@render reviewMark(reviewStatus)}
            {/if}
            {#if leadTabId || task.taskId}
              <button
                class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
                aria-label="Mark task completed"
                onclick={(e) => completeTask(task, e)}
              >
                <CheckIcon size={15} weight="bold" />
              </button>
              <button
                class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
                aria-label="Remove task from sidebar"
                onclick={(e) => removeTask(task, e)}
              >
                <XIcon size={15} />
              </button>
            {/if}
          </div>

          {#each taskSessions as child (child.sessionId ?? child.tabId ?? child.taskId)}
            {@const childActive = child.tabId === session.onScreenTabId}
            <div
              class="{rowBase} {childActive ? 'bg-(--solus-accent-light)' : 'bg-transparent active:bg-(--solus-surface-hover)'}"
              role="button"
              tabindex="0"
              data-active={childActive ? "true" : undefined}
              onclick={() => selectSession(child)}
              onkeydown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectSession(child);
                }
              }}
            >
              {#if childActive}{@render activeBar()}{/if}
              <span class="flex-1 min-w-0 flex flex-col gap-px">
                <span class="truncate text-[0.8125rem] leading-tight font-normal {childActive ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}">{child.label}</span>
                <span class="truncate text-[0.6875rem] leading-tight text-(--solus-text-tertiary)">{task.title}</span>
              </span>
              {#if child.attention}
                {@render attentionMark(child.attention)}
              {/if}
              {#if child.reviewGuideStatus}
                {@render reviewMark(child.reviewGuideStatus)}
              {/if}
              {#if child.isSubtask}
                <button
                  class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
                  aria-label="Mark subtask completed"
                  onclick={(e) => completeChild(child, e)}
                >
                  <CheckIcon size={15} weight="bold" />
                </button>
              {/if}
              {#if child.tabId || child.dismissalKey}
                <button
                  class="shrink-0 w-9 h-9 flex items-center justify-center rounded-full border-0 bg-transparent text-(--solus-text-muted) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-tertiary) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
                  aria-label="Remove subtask from sidebar"
                  onclick={(e) => removeChild(child, e)}
                >
                  <XIcon size={15} />
                </button>
              {/if}
            </div>
          {/each}
            {/each}
          </div>
        {/if}
      {/each}
    {:else}
      <div class="flex flex-col items-center gap-3 px-4 py-12 text-[0.8125rem] text-(--solus-text-tertiary)">
        <span>No open sessions</span>
        <button
          class="flex items-center gap-1.5 rounded-full border-0 bg-(--solus-accent-light) px-4 py-2 text-[0.8125rem] font-medium text-(--solus-accent) cursor-pointer transition-[background-color,transform] duration-[120ms] active:scale-[0.96] active:bg-(--solus-accent-border-medium) [-webkit-tap-highlight-color:transparent]"
          onclick={newSession}
        >
          <PlusIcon size={15} weight="bold" /> New session
        </button>
      </div>
    {/if}
  </div>

  <footer
    class="shrink-0 flex gap-0.5 border-t border-(--solus-container-border) px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom,0px))]"
  >
    {#snippet footBtn(label: string, Icon: typeof GearIcon, action: () => void)}
      <button
        class="flex-1 min-w-0 flex flex-col items-center gap-1 rounded-lg border-0 bg-transparent px-1 py-2 text-[0.625rem] font-medium text-(--solus-text-tertiary) cursor-pointer transition-colors duration-100 active:bg-(--solus-surface-hover) active:text-(--solus-text-secondary) [-webkit-tap-highlight-color:transparent]"
        onclick={() => nav(action)}
      >
        <Icon size={18} /><span>{label}</span>
      </button>
    {/snippet}
    {@render footBtn("Workspace", BooksIcon, () => session.toggleWorkspacePage())}
    {@render footBtn("History", ClockIcon, () => window.dispatchEvent(new CustomEvent("solus:toggle-session-picker")))}
    {@render footBtn("Settings", GearIcon, () => session.showSettings())}
  </footer>
</div>
