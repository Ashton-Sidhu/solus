<script lang="ts">
  import { localApi } from "@client-core/local-api";
  import {
    ArrowUUpLeftIcon,
    ArrowSquareOutIcon,
    CaretDownIcon,
    CheckIcon,
    FolderOpenIcon,
    PlusIcon,
    SidebarSimpleIcon,
    SpinnerGapIcon,
    XIcon,
  } from "phosphor-svelte";
  import { getWorkspaceContext, getSessionSidebarStore } from "../../contexts";
  import { frameChrome } from "../layout/frame-chrome.store.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
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
  import ProjectMark from "../session/ProjectMark.svelte";
  import SessionContextMenu from "../session/SessionContextMenu.svelte";
  import SessionNameInput from "../session/SessionNameInput.svelte";
  import TaskContextMenu from "../session/TaskContextMenu.svelte";
  import {
    projectInitial,
    taskStatusFor,
    type SidebarTask,
  } from "../session/lib/task-list";
  import { taskRef } from "../tasks/task-page/lib/task-page";
  import {
    breadcrumbLeafLabels,
    projectNote,
    statusColor,
    statusNote,
    type BreadcrumbDraftMode,
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
  }
  let {
    tabId,
    draft = null,
    showNewSessionAction = true,
    variant = "floating",
    showProjectPanelAction = true,
  }: Props = $props();

  const session = getWorkspaceContext();
  const sidebarStore = getSessionSidebarStore();

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

  // The project crumb is a click, not a hover: it is the one move that changes
  // everything under it, so it must not happen on the way past.
  let menu = $state<"project" | "task" | "session" | null>(null);
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
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
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

  const crumbButton =
    "flex h-[1.875rem] cursor-pointer items-center rounded px-[0.46875rem] transition-[background] duration-150 hover:bg-accent";
  const menuRow =
    "flex h-[2.125rem] w-full cursor-pointer items-center gap-[0.5625rem] rounded-md px-[0.5625rem] text-left transition-[background] duration-150 hover:bg-accent";
  const menuLabel =
    "min-w-0 flex-1 overflow-hidden text-[0.8125rem] text-ellipsis whitespace-nowrap";
  const menuHeading =
    "px-[0.5625rem] pt-1.5 pb-1.5 text-[0.5625rem] font-semibold tracking-[0.09em] text-muted-foreground uppercase";
  // Rows you can close reserve the slot the X lands in, so nothing reflows the
  // moment a pointer crosses the row.
  // The wash follows the row, not the pointer's exact target: reaching for the X
  // must not read as leaving the row.
  const menuRowClosable = `${menuRow} pr-7 group-hover/row:bg-accent`;
  const rowStatus = "shrink-0 text-[0.65625rem] font-medium whitespace-nowrap";
  const rowClose =
    "absolute top-1/2 right-[0.4375rem] flex size-[1.125rem] -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground opacity-0 transition-[opacity,background,color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100";
  const bandAction =
    "flex size-[1.875rem] shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-[background,color] duration-150 hover:bg-accent hover:text-foreground";
</script>

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
    class="crumb-band @container z-[3] flex items-center gap-px text-[0.84375rem] {variant ===
    'inline'
      ? 'crumb-band--inline relative h-full min-w-0 flex-1 px-1'
      : 'absolute inset-x-0 top-1 h-[2.875rem] pr-3.5'}"
    style={variant === "floating"
      ? "padding-left:max(1.125rem, var(--solus-chrome-lead-inset, 0px))"
      : undefined}
  >
    <Breadcrumb.Root
      aria-label="Location"
      class="flex min-w-0 shrink items-center"
    >
      <!-- The band, not the list, owns the type scale and the neutral colour:
           each crumb states its own, and the leaf stays full-contrast. -->
      <Breadcrumb.List
        class="min-w-0 flex-nowrap gap-px text-[0.84375rem] text-foreground"
      >
        <Breadcrumb.Item
          class="relative shrink-0"
          onmouseleave={() => (menu = null)}
        >
          <Breadcrumb.Link class="{crumbButton} gap-[0.4375rem] pl-[0.3125rem]">
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                title="Switch project"
                aria-expanded={menu === "project"}
                onclick={() => (menu = menu === "project" ? null : "project")}
              >
                <ProjectMark
                  {projectKey}
                  initial={projectInitial(projectLabel)}
                  active
                  class="size-4"
                  letterClass="text-[0.53125rem]"
                />
                <span class="whitespace-nowrap text-muted-foreground"
                  >{projectLabel}</span
                >
              </button>
            {/snippet}
          </Breadcrumb.Link>
          {#if menu === "project"}
            <div class="absolute top-[1.875rem] left-0 z-[8] pt-1.5">
              <div class="menu-surface w-[18.25rem] p-[0.3125rem]">
                <div class={menuHeading}>Projects</div>
                {#each sidebarStore.projectSummaries as project (project.projectKey)}
                  {@const note = projectNote(project.waiting, project.failed)}
                  <button
                    type="button"
                    class={menuRow}
                    onclick={() =>
                      pickProject(project.leadTaskKey, project.projectKey)}
                  >
                    <ProjectMark
                      projectKey={project.projectKey}
                      initial={project.initial}
                      active={project.projectKey === projectKey}
                      class="size-[1.125rem]"
                      letterClass="text-[0.5625rem]"
                    />
                    <span
                      class="{menuLabel} {project.projectKey === projectKey
                        ? 'font-medium'
                        : ''}">{project.label}</span
                    >
                    {#if note}
                      <span
                        class="shrink-0 text-[0.65625rem] font-medium"
                        style:color={note.tone === "primary"
                          ? "var(--solus-status-permission)"
                          : "var(--solus-status-error)"}>{note.text}</span
                      >
                    {/if}
                    <span
                      class="shrink-0 font-mono text-[0.625rem] text-muted-foreground opacity-50 tabular-nums"
                      >{project.count}</span
                    >
                  </button>
                {/each}
                <div
                  class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                ></div>
                <button
                  type="button"
                  class="{menuRow} h-8 text-muted-foreground hover:text-foreground"
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
                  <span class="flex-1 text-[0.8125rem]">Open project…</span>
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
          <!-- Hover to switch: a crumb is a menu. The menu stays open while the
               pointer is inside it, so switching is hover, read, click. -->
          <Breadcrumb.Item
            class="relative min-w-0 max-w-[12rem] shrink @max-[68rem]:max-w-[8rem] @max-[52rem]:max-w-[6rem]"
            onmouseenter={() => (menu = "task")}
            onmouseleave={() => (menu = null)}
          >
            <!-- Hover opens it, but the click and the focus have to as well: a menu
                 that only exists under a pointer is not reachable from the keyboard. -->
            <Breadcrumb.Link class="{crumbButton} max-w-full">
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  aria-expanded={menu === "task"}
                  title={leafLabels.task}
                  onclick={() => (menu = menu === "task" ? null : "task")}
                  onfocus={() => (menu = "task")}
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
                <div class="menu-surface w-[19.75rem] p-[0.3125rem]">
                  <div class={menuHeading}>Tasks in {projectLabel}</div>
                  {#each tasksInProject as item (item.id)}
                    {@const note = statusNote(item.status)}
                    <div class="group/row relative">
                      <button
                        type="button"
                        class={menuRowClosable}
                        onclick={() => selectTask(item)}
                        oncontextmenu={(event) =>
                          openTaskContextMenu(event, item)}
                      >
                        <span
                          class="{menuLabel} {item.key === task?.key
                            ? 'font-medium'
                            : ''}">{item.title}</span
                        >
                        {#if item.status === "running"}
                          <span
                            class={rowStatus}
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
                          <span class={rowStatus} style:color={note.color}
                            >{note.text}</span
                          >
                        {/if}
                      </button>
                      <button
                        type="button"
                        class={rowClose}
                        title="Close task"
                        aria-label="Close {item.title}"
                        onclick={() => closeTask(item)}
                      >
                        <XIcon size={14} weight="bold" />
                      </button>
                    </div>
                  {/each}
                  <div
                    class="mx-[0.5625rem] my-[0.3125rem] h-px bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
                  ></div>
                  <button
                    type="button"
                    class="{menuRow} h-8 text-muted-foreground hover:text-foreground"
                    onclick={newTask}
                  >
                    <PlusIcon size={14} class="shrink-0" />
                    <span class="flex-1 text-[0.8125rem]">New task</span>
                    <span class="font-mono text-[0.65625rem] opacity-60"
                      >{comboHint("global.new-task")}</span
                    >
                  </button>
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
            : 'max-w-[20rem] @max-[68rem]:max-w-[12rem] @max-[52rem]:max-w-[9rem]'}"
          onmouseenter={() => {
            if (renamingTabId !== tabId) menu = "session";
          }}
          onmouseleave={() => (menu = null)}
        >
          {#if renamingTabId === tabId}
            <!-- Editing in place: the leaf keeps its column and type ramp, only
                 the text turns into a field. Commit or cancel returns it to a
                 crumb and hands the caret back to the composer. -->
            <span class="flex h-[1.875rem] w-full items-center">
              <SessionNameInput
                value={current?.label ?? leafLabels.session}
                variant="band"
                class="text-[0.84375rem] font-medium tracking-[-0.005em]"
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
            <Breadcrumb.Link class="{crumbButton} max-w-full gap-[0.4375rem]">
              {#snippet child({ props })}
                <button
                  {...props}
                  type="button"
                  aria-expanded={menu === "session"}
                  title={leafLabels.session}
                  onclick={() => (menu = menu === "session" ? null : "session")}
                  onfocus={() => (menu = "session")}
                  oncontextmenu={(event) =>
                    current && openChildContextMenu(event, current)}
                >
                  <span
                    class="min-w-0 overflow-hidden font-medium tracking-[-0.005em] text-ellipsis whitespace-nowrap"
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
              <div class="menu-surface w-[18rem] p-[0.3125rem]">
                <div class={menuHeading}>Sessions</div>
                {#each sessions as child (child.sessionId ?? child.tabId ?? child.taskId)}
                  {@const status = taskStatusFor(child.attention)}
                  {@const note = statusNote(status)}
                  <div class="group/row relative">
                    <button
                      type="button"
                      class={menuRowClosable}
                      onclick={() => selectSession(child)}
                      oncontextmenu={(event) =>
                        openChildContextMenu(event, child)}
                    >
                      <span
                        class="{menuLabel} {child.tabId === tabId
                          ? 'font-medium'
                          : ''}">{child.label}</span
                      >
                      {#if status === "running"}
                        <span
                          class={rowStatus}
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
                        <span class={rowStatus} style:color={note.color}
                          >{note.text}</span
                        >
                      {/if}
                    </button>
                    {#if child.tabId}
                      <button
                        type="button"
                        class={rowClose}
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
                  class="{menuRow} h-8 text-muted-foreground hover:text-foreground"
                  onclick={newSession}
                >
                  <PlusIcon size={14} class="shrink-0" />
                  <span class="flex-1 text-[0.8125rem]"
                    >New session in this task</span
                  >
                  <span class="font-mono text-[0.65625rem] opacity-60"
                    >{comboHint("global.new-session")}</span
                  >
                </button>
              </div>
            </div>
          {/if}
        </Breadcrumb.Item>
      </Breadcrumb.List>
    </Breadcrumb.Root>

    <span class="min-w-4 flex-1"></span>

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
          class="font-mono text-[0.65625rem] whitespace-nowrap {taskDone
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
        class="{bandAction} @max-[36rem]:hidden {taskDone
          ? 'text-chart-3 hover:text-chart-3'
          : ''}"
        title={taskDone ? "Reopen task" : "Mark done"}
        aria-label={taskDone ? "Reopen task" : "Mark done"}
        onclick={() => {
          sidebarStore.toggleTaskDone(record.id);
          requestInputFocus();
        }}
      >
        {#if taskDone}
          <ArrowUUpLeftIcon size={14} weight="bold" />
        {:else}
          <CheckIcon size={14} weight="bold" />
        {/if}
      </button>

      <button
        type="button"
        class="{bandAction} @max-[36rem]:hidden"
        title="Open task page"
        aria-label="Open task page"
        onclick={() => session.goToTask(record.id)}
      >
        <ArrowSquareOutIcon size={14} />
      </button>

      {#if showNewSessionAction || (showProjectPanelAction && !frameChrome.projectPanelOpen)}
        <span
          class="mx-[0.4375rem] h-4 w-px shrink-0 bg-[color-mix(in_oklch,var(--foreground)_12%,transparent)]"
          aria-hidden="true"
        ></span>
      {/if}
    {/if}

    {#if showNewSessionAction}
      <button
        type="button"
        class="flex h-[1.875rem] shrink-0 cursor-pointer items-center gap-1.5 rounded pr-2.5 pl-2 transition-[background] duration-150 hover:bg-accent @max-[36rem]:size-[1.875rem] @max-[36rem]:justify-center @max-[36rem]:gap-0 @max-[36rem]:p-0"
        style="box-shadow:0 0 0 0.03125rem color-mix(in oklch, var(--foreground) 12%, transparent)"
        title="New session in this task"
        aria-label="New session in this task"
        onclick={newSession}
      >
        <PlusIcon size={14} class="text-muted-foreground" />
        <span
          class="text-[0.8125rem] font-medium whitespace-nowrap @max-[36rem]:hidden"
          >New Task</span
        >
      </button>
    {/if}

    {#if showProjectPanelAction && !frameChrome.projectPanelOpen}
      <button
        type="button"
        class={bandAction}
        title="Expand project panel"
        aria-label="Expand project panel"
        onclick={() => {
          frameChrome.toggleProjectPanelFromFrame?.();
          requestInputFocus();
        }}
      >
        <SidebarSimpleIcon size={14} mirrored />
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
        (session.tasksStore.sessionsByTask.get(menuTask.id)?.length ?? 0) > 0}
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
        onOpenTask={() => session.goToTask(menuTask.id)}
        onOpenSource={menuTask.url
          ? () => void localApi.openExternal(menuTask.url!)
          : undefined}
        onToggleDone={() => sidebarStore.toggleTaskDone(menuTask.id)}
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
    /* Match the native 52px titlebar band. Its 26px geometric centre sits one
       pixel below the stoplights' optical centre, matching the macOS chrome. */
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
