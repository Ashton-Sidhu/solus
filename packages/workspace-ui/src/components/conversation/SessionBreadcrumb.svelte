<script lang="ts">
  import { localApi } from "@solus/client-core/local-api";
  import {
    BAND_ACTION,
    CRUMB_BUTTON,
    MENU_HEADING,
    MENU_LABEL,
    MENU_ROW,
    MENU_ROW_CLOSABLE,
    ROW_CLOSE,
    ROW_STATUS,
    TASK_MENU_ROW,
  } from "./lib/breadcrumb-styles";
  import type { TaskStatus } from "@solus/contracts/task-types";
  import {
    Undo2 as ArrowUUpLeftIcon,
    ExternalLink as ArrowSquareOutIcon,
    ChevronDown as CaretDownIcon,
    Check as CheckIcon,
    FolderOpen as FolderOpenIcon,
    Plus as PlusIcon,
    PanelLeft as SidebarSimpleIcon,
    LoaderCircle as SpinnerGapIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { getWorkspaceContext, getSessionSidebarStore } from "../../contexts";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { comboHint } from "../../lib/keybindings/manifest";
  import { getAttentionIcon, hasSessionStarted } from "../../lib/sessionUtils";
  import { homeGitDetails } from "../../lib/git-context";
  import { projectDirLabel } from "../../lib/paths";
  import { withCheckout } from "../../contexts/workspace/run-config";
  import {
    existingTaskId,
    type SessionDraft,
  } from "../../contexts/workspace/session-draft.svelte";
  import type { SidebarSessionChild } from "../../contexts/workspace/session-sidebar.store.svelte";
  import * as Breadcrumb from "../ui/breadcrumb";
  import * as Command from "../ui/command";
  import { MenuSearch } from "../ui/menu";
  import ProjectFavicon from "../ui/ProjectFavicon.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import SessionNameInput from "../session/SessionNameInput.svelte";
  import TaskContextMenu from "../session/TaskContextMenu.svelte";
  import { taskStatusFor, type SidebarTask } from "../session/lib/task-list";
  import { taskRef } from "../tasks/task-page/lib/task-page";
  import {
    breadcrumbLeafLabels,
    breadcrumbTaskGroups,
    breadcrumbTaskMatches,
    completedSectionExpanded,
    projectNote,
    statusColor,
    statusNote,
    type BreadcrumbDraftMode,
    type CompletedSectionOverride,
  } from "./lib/session-breadcrumb";

  interface Props {
    /** The session on screen — the last crumb. Empty for a draft, which has no
     *  tab until its first prompt is sent. */
    tabId: string;
    /** The draft on screen, when the band names one that has yet to become a
     *  session. Its path is what the draft will create rather than where a
     *  conversation already is. */
    draft?: SessionDraft | null;
    /** A fresh session does not need an action that creates another one. */
    showNewSessionAction?: boolean;
    /** Inline breadcrumbs fill pane chrome; floating breadcrumbs overlay a transcript. */
    variant?: "floating" | "inline";
    /** Split panes own a separate project-panel toggle beside the breadcrumb. */
    showProjectPanelAction?: boolean;
    /** Explicit rail state and command for a pane whose rail is not frame-owned. */
    projectPanelOpen?: boolean;
    onProjectPanelToggle?: () => void;
    /** Optional pane-close control in the shared header action cluster. */
    onOpenAsPage?: () => void;
    onClose?: () => void;
    closeLabel?: string;
  }
  let {
    tabId,
    draft = null,
    showNewSessionAction = true,
    variant = "floating",
    showProjectPanelAction = true,
    projectPanelOpen,
    onProjectPanelToggle,
    onOpenAsPage,
    onClose,
    closeLabel = "Close pane",
  }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();
  let taskQuery = $state("");

  // A draft is in no list, so its task crumb is the record it names — nothing
  // when it will mint its own — and its session crumb has no siblings to offer.
  const draftTaskId = $derived(draft ? existingTaskId(draft.task) : null);
  const task = $derived(
    draft
      ? ((draftTaskId
          ? sidebarStore.allTasks.find((item) => item.taskId === draftTaskId)
          : null) ?? null)
      : sidebarStore.taskForTab(tabId),
  );
  const sessions = $derived(draft ? [] : sidebarStore.sessionsForTab(tabId));
  // The project the band stands in: a draft names its own, so the crumb reads
  // off the run it will use rather than off a task row it does not have.
  const projectKey = $derived(
    draft
      ? (homeGitDetails(
          draft.run.workingDirectory ?? "~",
          draft.run.gitContext ?? null,
          session.globalDefaults.gitContext,
        ).projectRoot ??
          draft.run.workingDirectory ??
          "~")
      : (task?.projectKey ?? "~"),
  );
  const projectLabel = $derived(
    draft
      ? projectDirLabel(projectKey, session.staticInfo?.workspacePath)
      : (task?.projectLabel ?? "~"),
  );
  const tasksInProject = $derived(sidebarStore.tasksForProject(projectKey));
  const filteredTasksInProject = $derived(
    tasksInProject.filter((item) =>
      breadcrumbTaskMatches(item.title, taskQuery),
    ),
  );
  const taskGroups = $derived(breadcrumbTaskGroups(filteredTasksInProject));
  // Completed work is history, so it stays folded away until asked for — either
  // by clicking the section or by typing a query that lands inside it. A click
  // is remembered against the query it was made at, so it can fold a search's
  // matches away again without the next keystroke inheriting that decision.
  let completedOverride = $state<CompletedSectionOverride | null>(null);
  const completedVisible = $derived(
    completedSectionExpanded(
      completedOverride,
      taskQuery,
      taskGroups.completed.length,
    ),
  );
  const current = $derived(sessions.find((child) => child.tabId === tabId));
  const displayedSession = $derived(session.sessionFor(tabId));
  const draftMode = $derived.by((): BreadcrumbDraftMode => {
    const target = draft?.task ?? displayedSession?.task;
    if (!draft && hasSessionStarted(displayedSession)) return null;
    if (target?.kind === "none") return "no-task";
    return target?.kind === "existing" ? "existing-task" : "new-task";
  });
  const leafLabels = $derived(
    breadcrumbLeafLabels(
      task?.title ?? "Task",
      current?.label ?? "Session",
      draftMode,
    ),
  );
  // Undelivered agent writes against this task (ADR-0007): while any exist the
  // crumb carries a dot, because the board the user files this task on is
  // behind by exactly that much.
  const taskSyncOps = $derived(
    task?.taskId ? session.outboxStore.pendingOpsFor("tasks", task.taskId) : [],
  );
  const taskSyncFailed = $derived(
    taskSyncOps.some((op) => op.state === "failed"),
  );
  // The durable record behind the task crumb. Loose session rows have none, and
  // the controls that act on a task have nothing to act on until one exists.
  const taskRecord = $derived(
    task?.taskId
      ? session.tasksStore.tasks.find((record) => record.id === task.taskId)
      : undefined,
  );
  const taskDone = $derived(taskRecord?.status === "done");
  const currentStatus = $derived(taskStatusFor(current?.attention ?? null));
  const statusIcon = $derived(getAttentionIcon(current?.attention ?? null));
  const currentStatusColor = $derived(statusColor(currentStatus));

  // Every crumb is a click, not a hover: a menu that opens on the way past
  // fights the click that would toggle it, and on the mac editor the drag
  // region between crumbs swallows the pointer, so hover could not even be
  // trusted to close it. One menu at a time; a click elsewhere or Esc closes it.
  let menu = $state<"project" | "task" | "session" | null>(null);
  let bandEl = $state<HTMLElement | null>(null);

  function toggleMenu(kind: "project" | "session") {
    menu = menu === kind ? null : kind;
  }

  // Dismissal lives on the document, not on a scrim: a click on another crumb
  // has to open that crumb's menu in the same press, and a click on the
  // transcript has to reach it. Esc runs in the capture phase so it wins over
  // the page's own Esc handler and does not close the pane underneath.
  $effect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && bandEl?.contains(event.target)) return;
      menu = null;
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      menu = null;
      requestInputFocus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeydown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeydown, true);
    };
  });
  // The leaf crumb edits its own name in place, mirroring the sidebar rows: set
  // to the leaf's tabId while its label is a live input rather than text.
  let renamingTabId = $state<string | null>(null);
  let sessionMenuAnchor = $state<HTMLElement | null>(null);
  let contextMenu = $state<
    | { kind: "task"; item: SidebarTask; x: number; y: number }
    | { kind: "session"; child: SidebarSessionChild; x: number; y: number }
    | null
  >(null);

  function openTaskContextMenu(event: MouseEvent, item: SidebarTask) {
    event.preventDefault();
    event.stopPropagation();
    menu = null;
    if (!item.taskId) {
      const child = sidebarStore
        .sessionsFor(item)
        .find((candidate) => candidate.tabId === tabId);
      if (child)
        contextMenu = {
          kind: "session",
          child,
          x: event.clientX,
          y: event.clientY,
        };
      return;
    }
    contextMenu = { kind: "task", item, x: event.clientX, y: event.clientY };
  }

  function openChildContextMenu(event: MouseEvent, child: SidebarSessionChild) {
    event.preventDefault();
    event.stopPropagation();
    menu = null;
    contextMenu = {
      kind: "session",
      child,
      x: event.clientX,
      y: event.clientY,
    };
  }

  /** The task code is a click menu, and it drops from the button rather than
   *  from the pointer so it opens in the same place every time. */
  function openTaskActions(event: MouseEvent, item: SidebarTask) {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    menu = null;
    contextMenu = { kind: "task", item, x: rect.left, y: rect.bottom + 4 };
  }

  /** Picking a task on a draft files it there rather than navigating away —
   *  the draft is what is being aimed, and its prompt comes with it. */
  function selectTask(next: SidebarTask) {
    menu = null;
    if (draft) {
      draft.task = next.taskId
        ? { kind: "existing", taskId: next.taskId }
        : { kind: "new" };
    } else {
      void sidebarStore.selectTask(next);
    }
    requestInputFocus();
  }

  function openTaskPicker() {
    if (menu !== "task") {
      taskQuery = "";
      completedOverride = null;
    }
    menu = "task";
  }

  function toggleTaskPicker() {
    if (menu === "task") menu = null;
    else openTaskPicker();
  }

  function selectSession(next: SidebarSessionChild) {
    menu = null;
    void sidebarStore.selectChild(next);
    requestInputFocus();
  }

  /** Closing the row you are standing on moves you elsewhere, so the menu that
   *  described the old location has to go with it. Closing any other row leaves
   *  the menu open — you came here to tidy up, and one close is rarely one. */
  function closeTask(item: SidebarTask) {
    if (item.key === task?.key) menu = null;
    sidebarStore.closeTask(item);
    requestInputFocus();
  }

  /** Completing from the band clears the mounted conversation too, the same
   *  way the sidebar checkmark and the row's close control do. */
  async function completeTask(item: SidebarTask) {
    try {
      await sidebarStore.completeTask(item);
    } catch (error) {
      toasts.error("Couldn't complete task", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestInputFocus();
    }
  }

  async function setTaskStatus(taskId: string, status: TaskStatus) {
    try {
      await session.tasksStore.get(taskId).setStatus(status);
    } catch (error) {
      toasts.error("Couldn't update task status", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      requestInputFocus();
    }
  }

  function closeSession(childTabId: string) {
    if (childTabId === tabId) menu = null;
    sidebarStore.closeTabs([childTabId]);
    requestInputFocus();
  }

  /** Choosing a project lands on its most urgent task — or, on a draft, moves
   *  the draft itself into that project. */
  function pickProject(leadTaskKey: string, nextProjectKey: string) {
    menu = null;
    if (draft) {
      draft.run = withCheckout(draft.run, nextProjectKey, null);
      void session.environment.refresh(nextProjectKey);
    } else {
      const lead = sidebarStore.allTasks.find(
        (item) => item.key === leadTaskKey,
      );
      if (lead) void sidebarStore.selectTask(lead);
    }
    requestInputFocus();
  }

  async function newSession() {
    menu = null;
    session.openSessionDraft({ via: "click", sourceTabId: tabId });
    requestInputFocus();
  }

  function newTask() {
    menu = null;
    session.openSessionDraft({
      freshTask: true,
      via: "click",
      sourceTabId: tabId,
    });
  }

  const isProjectPanelOpen = $derived(
    projectPanelOpen ?? frameChrome.projectPanelOpen,
  );
  const hasTrailingActions = $derived(
    showNewSessionAction ||
      (showProjectPanelAction && !isProjectPanelOpen) ||
      !!onOpenAsPage ||
      !!onClose,
  );

  function toggleProjectPanel() {
    if (onProjectPanelToggle) {
      onProjectPanelToggle();
      return;
    }
    frameChrome.toggleProjectPanelFromFrame?.();
    requestInputFocus();
  }
</script>

<!-- One task row, shared by the open and completed sections of the picker. -->
{#snippet taskRow(item: SidebarTask)}
  {@const note = statusNote(item.status)}
  <div class="group/row relative">
    <Command.Item
      value="{item.title} {item.taskId ?? item.id}"
      class={TASK_MENU_ROW}
      data-menu-current={item.key === task?.key ? "" : undefined}
      onSelect={() => selectTask(item)}
      oncontextmenu={(event) => openTaskContextMenu(event, item)}
    >
      <span class={MENU_LABEL}>{item.title}</span>
      {#if item.status === "running"}
        <span class={ROW_STATUS} role="img" aria-label="Running" title="Running">
          <SpinnerGapIcon
            size={14}
            class="animate-spin motion-reduce:animate-none"
          />
        </span>
      {:else if note}
        <span class={ROW_STATUS} style:color={note.color}>{note.text}</span>
      {/if}
    </Command.Item>
    <button
      type="button"
      class={ROW_CLOSE}
      title="Close task"
      aria-label="Close {item.title}"
      onclick={() => closeTask(item)}
    >
      <XIcon size={14} weight="bold" />
    </button>
  </div>
{/snippet}

{#if task || draft}
  <!-- Scrim: the transcript dissolves into the background under the band rather
       than being clipped by a hard edge. -->
  {#if variant === "floating"}
    <div
      class="pointer-events-none absolute inset-x-0 top-0 z-[2] h-24"
      style="background:linear-gradient(to bottom, var(--background) 56%, transparent)"
      aria-hidden="true"
    ></div>
  {/if}

  <!-- One band across the top of the window: traffic lights and the panel toggle
       on the left (owned by the frame), the crumb continuing across it. On the
       mac editor its height matches the native titlebar band so both rows share
       a centreline. The crumb has no container of its own — it is plain text on
       the band, and the only affordance is the hover wash under each part. -->
  <div
    bind:this={bandEl}
    class="workspace-titlebar crumb-band @container z-[3] flex items-center gap-px text-workspace-chrome {variant ===
 'inline'
 ? 'crumb-band--inline relative h-full min-w-0 flex-1 px-1'
 : 'absolute inset-x-0 top-1 h-[2.875rem] pr-3.5'}"
    style={variant === "floating"
      ? "padding-left:max(1.125rem, var(--solus-chrome-lead-inset, 0px))"
      : undefined}
  >
    <!-- no-drag on the whole crumb, not only its buttons: on the mac editor the
         band is a window-drag region, and the separators, the gaps, and the
         edges of each item would otherwise belong to the window rather than
         to the pointer — dead spots a click could land on and lose. The empty
         run to the right of the crumb is what drags the window. -->
    <Breadcrumb.Root
      aria-label="Location"
      class="no-drag flex min-w-0 shrink items-center"
    >
      <!-- The band, not the list, owns the type scale and the neutral colour:
           each crumb states its own, and the leaf stays full-contrast. -->
      <Breadcrumb.List
        class="min-w-0 flex-nowrap gap-px text-foreground"
      >
        <Breadcrumb.Item class="relative shrink-0">
          <Breadcrumb.Link class="{CRUMB_BUTTON} gap-[0.4375rem] pl-[0.3125rem]">
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                title="Switch project"
                aria-haspopup="menu"
                aria-expanded={menu === "project"}
                onclick={() => toggleMenu("project")}
              >
                <ProjectFavicon projectRoot={projectKey} class="size-4" />
                <span class="whitespace-nowrap text-muted-foreground"
                  >{projectLabel}</span
                >
              </button>
            {/snippet}
          </Breadcrumb.Link>
          {#if menu === "project"}
            <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
              <div class="menu-surface w-[min(18.25rem,calc(100vw-2rem))] [.is-laptop-display_&]:w-[min(15.25rem,calc(100vw-2rem))] p-[0.3125rem] text-chrome-dense">
                <div class={MENU_HEADING}>Projects</div>
                {#each sidebarStore.projectSummaries as project (project.projectKey)}
                  {@const note = projectNote(project.waiting, project.failed)}
                  <button
                    type="button"
                    class={MENU_ROW}
                    onclick={() =>
                      pickProject(project.leadTaskKey, project.projectKey)}
                  >
                    <ProjectFavicon
                      projectRoot={project.projectKey}
                      class="size-[1.125rem]"
                    />
                    <span
                      class="{MENU_LABEL} {project.projectKey === projectKey
 ? 'font-medium'
 : ''}">{project.label}</span
                    >
                    {#if note}
                      <span
                        class="shrink-0 text-xs font-medium"
                        style:color={note.tone === "primary"
                          ? "var(--solus-status-permission)"
                          : "var(--solus-status-error)"}>{note.text}</span
                      >
                    {/if}
                    <span
                      class="shrink-0 text-xs text-muted-foreground opacity-50 tabular-nums"
                      >{project.count}</span
                    >
                  </button>
                {/each}
                <div
                  class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                ></div>
                <button
                  type="button"
                  class="{MENU_ROW} h-8 text-muted-foreground hover:text-foreground"
                  onclick={() => {
                    menu = null;
                    window.dispatchEvent(
                      // No tab to name on a draft: the flow then opens the
                      // project as a draft, which re-aims this pane's own.
                      new CustomEvent("solus:open-project", {
                        detail: { tabId: draft ? undefined : tabId },
                      }),
                    );
                  }}
                >
                  <FolderOpenIcon size={14} class="shrink-0" />
                  <span class="flex-1">Open project…</span>
                </button>
              </div>
            </div>
          {/if}
        </Breadcrumb.Item>

        <Breadcrumb.Separator
          class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30"
          >/</Breadcrumb.Separator
        >

        {#if leafLabels.task}
          <!-- Click to switch: a crumb is a menu. Enter and Space are clicks
               too, so the keyboard reaches it without a focus handler that
               would reopen the menu the moment a click tries to close it. -->
          <Breadcrumb.Item
            class="relative min-w-0 max-w-[clamp(6rem,16cqw,12rem)] shrink"
          >
            <Breadcrumb.Link class="{CRUMB_BUTTON} max-w-full">
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "task"}
                  title={leafLabels.task}
                  onclick={toggleTaskPicker}
                  oncontextmenu={(event) =>
                    task && openTaskContextMenu(event, task)}
                >
                  <span
                    class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground"
                    >{leafLabels.task}</span
                  >
                  {#if taskSyncOps.length}
                    <!-- Agent task writes recorded on the execution host that
                         have not reached the task's own host yet (ADR-0007). -->
                    <span
                      class="ml-1 size-1.5 shrink-0 rounded-full {taskSyncFailed
 ? 'bg-red-500'
 : 'bg-amber-500'}"
                      title={taskSyncFailed
                        ? "Some task updates failed to sync"
                        : `${taskSyncOps.length} task update${taskSyncOps.length === 1 ? "" : "s"} waiting to sync`}
                      aria-label="Task updates waiting to sync"
                    ></span>
                  {/if}
                </button>
              {/snippet}
            </Breadcrumb.Link>
            {#if menu === "task"}
              <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
                <div class="menu-surface w-[min(19.75rem,calc(100vw-2rem))] [.is-laptop-display_&]:w-[min(16.25rem,calc(100vw-2rem))] overflow-hidden p-0 text-chrome-dense">
                  <Command.Root shouldFilter={false}>
                    <MenuSearch
                      bind:value={taskQuery}
                      placeholder="Search tasks in {projectLabel}"
                    />
                    <Command.List
                      class="max-h-[min(24rem,calc(100vh-8rem))] [.is-laptop-display_&]:max-h-[min(17.5rem,calc(100vh-7rem))] overflow-y-auto p-[0.3125rem]"
                    >
                      {#if filteredTasksInProject.length === 0}
                        <div
                          class="px-3 py-6 text-center text-xs text-muted-foreground"
                        >
                          No tasks match
                        </div>
                      {/if}

                      {#if taskGroups.open.length > 0}
                        <Command.Group>
                          <!-- Both section headers are written here rather than
                               taken from the group's own heading slot: one of
                               them is a control, and the two only read as a pair
                               while they share one type and one label column.
                               Every label in the list — header, task, footer —
                               starts at the row padding; the caret that opens
                               the completed section is a trailing affordance so
                               nothing is pushed off that edge. -->
                          <div
                            class="mb-1 flex h-[1.625rem] [.is-laptop-display_&]:h-[1.375rem] items-center gap-1.5 [.is-laptop-display_&]:gap-1 px-[0.5625rem] text-chrome-shelf font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase"
                          >
                            <span>Open</span>
                            <span class="tabular-nums opacity-50"
                              >{taskGroups.open.length}</span
                            >
                          </div>
                          {#each taskGroups.open as item (item.id)}
                            {@render taskRow(item)}
                          {/each}
                        </Command.Group>
                      {/if}

                      {#if taskGroups.completed.length > 0}
                        <Command.Group>
                          <!-- A row, not a label beside one: the pointer moving
                               onto it has to take the highlight off the task
                               above, and the keyboard has to be able to arrow
                               onto it and open the section with Enter. -->
                          <Command.Item
                            value="completed tasks section"
                            class="{completedVisible
                              ? 'mb-1'
                              : ''} h-[1.625rem] [.is-laptop-display_&]:h-[1.375rem] gap-1.5 [.is-laptop-display_&]:gap-1 rounded-md px-[0.5625rem] text-chrome-shelf font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase"
                            aria-expanded={completedVisible}
                            onSelect={() =>
                              (completedOverride = {
                                query: taskQuery,
                                expanded: !completedVisible,
                              })}
                          >
                            <span>Completed</span>
                            <span class="tabular-nums opacity-50"
                              >{taskGroups.completed.length}</span
                            >
                            <CaretDownIcon
                              size={11}
                              weight="bold"
                              class="ml-auto shrink-0 [.is-laptop-display_&]:size-[0.625rem] transition-transform duration-150 {completedVisible
 ? ''
 : '-rotate-90'}"
                            />
                          </Command.Item>
                          {#if completedVisible}
                            {#each taskGroups.completed as item (item.id)}
                              {@render taskRow(item)}
                            {/each}
                          {/if}
                        </Command.Group>
                      {/if}

                      <div
                        class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                      ></div>
                      <Command.Item
                        value="new task create"
                        class="{MENU_ROW} h-8 text-chrome-dense text-muted-foreground hover:text-foreground"
                        onSelect={newTask}
                      >
                        <PlusIcon size={14} class="shrink-0" />
                        <span class="flex-1">New task</span>
                        <span class="text-xs opacity-60"
                          >{comboHint("global.new-task")}</span
                        >
                      </Command.Item>
                    </Command.List>
                  </Command.Root>
                </div>
              </div>
            {/if}
          </Breadcrumb.Item>

          <Breadcrumb.Separator
            class="shrink-0 px-[0.1875rem] text-muted-foreground opacity-30"
            >/</Breadcrumb.Separator
          >
        {/if}

        <!-- Capped like the task crumb: on a laptop band the leaf otherwise
             keeps the whole remainder and pushes the trailing actions off. -->
        <Breadcrumb.Item
          class="relative min-w-0 shrink {renamingTabId === tabId
 ? 'w-[min(20rem,42vw)]'
 : 'max-w-[clamp(9rem,28cqw,20rem)]'}"
        >
          {#if renamingTabId === tabId}
            <!-- Editing in place: the leaf keeps its column and type ramp, only
                 the text turns into a field. Commit or cancel returns it to a
                 crumb and hands the caret back to the composer. -->
            <span class="flex h-[1.875rem] w-full items-center">
              <SessionNameInput
                value={current?.label ?? leafLabels.session}
                variant="band"
                class="font-medium"
                onCommit={(next) => {
                  void session.renameTab(tabId, next);
                  renamingTabId = null;
                  requestInputFocus();
                }}
                onCancel={() => {
                  renamingTabId = null;
                  requestInputFocus();
                }}
              />
            </span>
          {:else}
            <Breadcrumb.Link class="{CRUMB_BUTTON} max-w-full gap-[0.4375rem]">
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "session"}
                  title={leafLabels.session}
                  onclick={() => toggleMenu("session")}
                  ondblclick={() => {
                    // Rename where the name is. The two clicks underneath have
                    // already toggled the menu open and shut; drop it anyway
                    // so the field never renders behind it.
                    menu = null;
                    renamingTabId = tabId;
                  }}
                  oncontextmenu={(event) =>
                    current && openChildContextMenu(event, current)}
                >
                  <span
                    class="min-w-0 overflow-hidden font-medium text-ellipsis whitespace-nowrap"
                    >{leafLabels.session}</span
                  >
                  {#if statusIcon}
                    {@const StatusIcon = statusIcon.component}
                    <span
                      class="flex size-[0.8125rem] shrink-0 items-center justify-center {statusIcon.spin
 ? 'animate-spin motion-reduce:animate-none'
 : ''}"
                      style:color={currentStatusColor ?? statusIcon.color}
                      role="img"
                      aria-label={statusNote(currentStatus)?.text}
                      title={statusNote(currentStatus)?.text}
                    >
                      <StatusIcon size={14} weight="regular" />
                    </span>
                  {/if}
                </button>
              {/snippet}
            </Breadcrumb.Link>
          {/if}
          {#if menu === "session"}
            <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
              <div class="menu-surface w-[min(18rem,calc(100vw-2rem))] [.is-laptop-display_&]:w-[min(15rem,calc(100vw-2rem))] p-[0.3125rem] text-chrome-dense">
                <div class={MENU_HEADING}>Sessions</div>
                {#each sessions as child (child.sessionId ?? child.tabId ?? child.taskId)}
                  {@const status = taskStatusFor(child.attention)}
                  {@const note = statusNote(status)}
                  <div class="group/row relative">
                    <button
                      type="button"
                      class={MENU_ROW_CLOSABLE}
                      onclick={() => selectSession(child)}
                      oncontextmenu={(event) =>
                        openChildContextMenu(event, child)}
                    >
                      <span
                        class="{MENU_LABEL} {child.tabId === tabId
 ? 'font-medium'
 : ''}">{child.label}</span
                      >
                      {#if status === "running"}
                        <span
                          class={ROW_STATUS}
                          role="img"
                          aria-label="Running"
                          title="Running"
                        >
                          <SpinnerGapIcon
                            size={14}
                            class="animate-spin motion-reduce:animate-none"
                          />
                        </span>
                      {:else if note}
                        <span class={ROW_STATUS} style:color={note.color}
                          >{note.text}</span
                        >
                      {/if}
                    </button>
                    {#if child.tabId}
                      <button
                        type="button"
                        class={ROW_CLOSE}
                        title="Close session"
                        aria-label="Close {child.label}"
                        onclick={() => closeSession(child.tabId!)}
                      >
                        <XIcon size={14} weight="bold" />
                      </button>
                    {/if}
                  </div>
                {/each}
                <div
                  class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                ></div>
                <button
                  type="button"
                  class="{MENU_ROW} h-8 text-muted-foreground hover:text-foreground"
                  onclick={newSession}
                >
                  <PlusIcon size={14} class="shrink-0" />
                  <span class="flex-1"
                    >New session in this task</span
                  >
                  <span class="text-xs opacity-60"
                    >{comboHint("global.new-session")}</span
                  >
                </button>
              </div>
            </div>
          {/if}
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>

    <span class="min-w-4 flex-1 self-stretch" aria-hidden="true"></span>

    <!-- The task's own controls, right of the crumb and before the session
         cluster: the code is a menu of everything you can do to the task, with
         the two moves you make most — mark done, open the task page — also
         standing on their own. Done tints the code and its wash. -->
    {#if taskRecord && task}
      {@const record = taskRecord}
      <button
        type="button"
        class="flex h-[1.875rem] shrink-0 cursor-pointer items-center gap-1.5 rounded px-[0.4375rem] transition-[background] duration-150 hover:bg-accent {taskDone
 ? 'bg-[color-mix(in_oklch,var(--chart-3)_12%,transparent)]'
 : ''}"
        title="Task actions"
        aria-haspopup="menu"
        onclick={(event) => openTaskActions(event, task)}
      >
        {#if taskDone}
          <CheckIcon size={14} weight="bold" class="shrink-0 text-chart-3" />
        {/if}
        <span
          class="text-xs whitespace-nowrap {taskDone
 ? 'text-chart-3'
 : 'opacity-75'}">{taskRef(record)}</span
        >
        <CaretDownIcon
          size={14}
          weight="bold"
          class="shrink-0 text-muted-foreground opacity-60"
        />
      </button>

      <button
        type="button"
        class="{BAND_ACTION} @max-[36rem]:hidden {taskDone
 ? 'text-chart-3 hover:text-chart-3'
 : ''}"
        title={taskDone ? "Reopen task" : "Mark done"}
        aria-label={taskDone ? "Reopen task" : "Mark done"}
        onclick={() => void completeTask(task)}
      >
        {#if taskDone}
          <ArrowUUpLeftIcon size={14} weight="bold" />
        {:else}
          <CheckIcon size={14} weight="bold" />
        {/if}
      </button>

      <button
        type="button"
        class="{BAND_ACTION} @max-[36rem]:hidden"
        title="Open task page"
        aria-label="Open task page"
        onclick={() => session.goToTask(record.id, "click", "secondary")}
      >
        <ArrowSquareOutIcon size={14} />
      </button>

      {#if hasTrailingActions}
        <span
          class="mx-[0.4375rem] h-4 w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
          aria-hidden="true"
        ></span>
      {/if}
    {/if}

    {#if showNewSessionAction}
      <button
        type="button"
        class="flex h-[1.6875rem] shrink-0 cursor-pointer items-center gap-1 rounded pr-2 pl-1.5 transition-[background] duration-150 hover:bg-accent @max-[36rem]:size-[1.6875rem] @max-[36rem]:justify-center @max-[36rem]:gap-0 @max-[36rem]:p-0"
        style="box-shadow:0 0 0 0.03125rem color-mix(in oklch, var(--foreground) 12%, transparent)"
        title="New session in this task"
        aria-label="New session in this task"
        onclick={newSession}
      >
        <PlusIcon size={12} class="text-muted-foreground" />
        <span
          class="text-workspace-chrome font-medium whitespace-nowrap @max-[36rem]:hidden"
          >New Task</span
        >
      </button>
    {/if}

    {#if showProjectPanelAction && !isProjectPanelOpen}
      <button
        type="button"
        class={BAND_ACTION}
        title="Expand project panel"
        aria-label="Expand project panel"
        onclick={toggleProjectPanel}
      >
        <SidebarSimpleIcon size={14} mirrored />
      </button>
    {/if}

    {#if onOpenAsPage}
      <button
        type="button"
        class={BAND_ACTION}
        title="Open as page"
        aria-label="Open as page"
        onclick={onOpenAsPage}
      >
        <ArrowSquareOutIcon size={15} />
      </button>
    {/if}

    {#if onClose}
      <button
        type="button"
        class={BAND_ACTION}
        title={closeLabel}
        aria-label={closeLabel}
        onclick={onClose}
      >
        <XIcon size={16} />
      </button>
    {/if}
  </div>

  {#if contextMenu?.kind === "session"}
    {@const menuChild = contextMenu.child}
    <SessionContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      tabId={menuChild.tabId ?? null}
      sessionId={menuChild.sessionId ?? null}
      showSplit
      onStartRename={(target) => {
        // The leaf is the only session the band draws, so only it can turn into
        // a field. Renaming any other session picked from the dropdown keeps the
        // dialog — there is no in-place row for it once the menu has closed.
        if (target === tabId) renamingTabId = target;
        else session.ui.sessionRename = { tabId: target };
      }}
      rowActions={{
        onStop:
          menuChild.tabId && menuChild.attention === "running"
            ? () => session.interruptTabSession(menuChild.tabId!)
            : undefined,
      }}
      onClose={() => (contextMenu = null)}
    />
  {:else if contextMenu?.kind === "task"}
    {@const menuSidebarTask = contextMenu.item}
    {@const menuTask = menuSidebarTask.taskId
      ? session.tasksStore.tasks.find(
          (record) => record.id === menuSidebarTask.taskId,
        )
      : undefined}
    {#if menuTask}
      {@const hasLinkedSession =
        menuSidebarTask.tabIds.length > 0 ||
        (session.tasksStore.get(menuTask.id).sessions.length) > 0}
      <TaskContextMenu
        x={contextMenu.x}
        y={contextMenu.y}
        task={menuTask}
        {hasLinkedSession}
        isRunning={menuSidebarTask.status === "running"}
        onStart={() => void session.openTaskSession(menuTask)}
        onResume={hasLinkedSession
          ? () => void session.openTaskLinkedSession(menuTask)
          : undefined}
        onStop={menuSidebarTask.status === "running"
          ? () => {
              for (const taskTabId of menuSidebarTask.tabIds) {
                session.interruptTabSession(taskTabId);
              }
            }
          : undefined}
        onOpenTask={() => session.goToTask(menuTask.id, "click", "secondary")}
        onOpenSource={menuTask.url
          ? () => void localApi.openExternal(menuTask.url!)
          : undefined}
        onSetStatus={(status) => void setTaskStatus(menuTask.id, status)}
        onRemove={() => closeTask(menuSidebarTask)}
        onClose={() => (contextMenu = null)}
      />
    {/if}
  {/if}
{/if}

<style>
  .crumb-band {
    animation: crumb-enter 0.18s ease-out;
  }

  :global(html.is-mac-editor) .crumb-band:not(.crumb-band--inline) {
    top: 0;
    height: var(--solus-titlebar-height);
  }

  @keyframes crumb-enter {
    from {
      opacity: 0;
      transform: translateY(-0.25rem);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .crumb-band {
      animation: none;
    }
  }
</style>
