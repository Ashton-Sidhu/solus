<script lang="ts">
  import type {
    Task,
    TaskLink,
    TaskLinkInput,
    TaskUpdatePatch,
  } from "../../../../shared/task-types";
  import { getWorkspaceContext } from "../../../contexts";
  import { findOpenTabForSession } from "../../../lib/sessionUtils";
  import { toasts } from "../../../lib/toasts";
  import {
    useKeybinding,
    useScope,
  } from "../../../lib/keybindings/use-keybinding.svelte";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { sortTasks } from "../lib/tasks-api";
  import { taskPageCapabilities } from "./lib/task-page";
  import TaskActivityFeed from "./TaskActivityFeed.svelte";
  import TaskChromeBar from "./TaskChromeBar.svelte";
  import TaskCommentComposer from "./TaskCommentComposer.svelte";
  import TaskHeader from "./TaskHeader.svelte";
  import TaskLinkPicker from "./TaskLinkPicker.svelte";
  import TaskLinkedTable from "./TaskLinkedTable.svelte";
  import TaskSessionsList from "./TaskSessionsList.svelte";
  import TaskSidebar from "./TaskSidebar.svelte";

  let { params, paneId }: RouteSurfaceProps<"task"> = $props();

  const session = getWorkspaceContext();
  const store = session.tasksStore;
  const pane = paneActions(paneId);

  const taskId = $derived(params.taskId);
  const task = $derived(store.taskForId(taskId));
  const details = $derived(store.detailsFor(taskId));
  const links = $derived(details?.links ?? []);
  const sessions = $derived(store.sessionsByTask.get(taskId) ?? []);
  const projectCwd = $derived(task?.projectKey ?? session.tasksProjectCwd ?? undefined);
  const projectLabel = $derived(
    projectCwd ? (projectCwd.split("/").pop() ?? projectCwd) : "Inbox",
  );
  const capabilities = $derived(task ? taskPageCapabilities(task) : null);

  let picking = $state(false);
  let refreshing = $state(false);

  // The route param is the request: whenever it names a task we haven't read the
  // detail of, fetch it. A $derived can't express "go do IO", so this is one of
  // the cases $effect is actually for.
  let loadedId: string | null = null;
  $effect(() => {
    const id = taskId;
    if (!id || id === loadedId) return;
    loadedId = id;
    void store.ensureLoaded().catch(() => {});
    void store
      .loadDetails(id, projectCwd)
      .catch((err) => toastError("open task", err));
  });

  // ── Prev/next follow the Tasks page's own ordering, so "next" is the row the
  // user actually saw underneath this one. ──
  const siblings = $derived(
    sortTasks(
      task?.projectKey ? store.tasksForProject(task.projectKey) : store.inbox,
      "updated",
    ),
  );
  const position = $derived(siblings.findIndex((t) => t.id === taskId));
  const previous = $derived(position > 0 ? siblings[position - 1] : null);
  const next = $derived(
    position >= 0 && position < siblings.length - 1 ? siblings[position + 1] : null,
  );

  function toastError(action: string, err: unknown) {
    toasts.error(`Couldn't ${action}: ${err instanceof Error ? err.message : String(err)}`);
  }

  function save(patch: TaskUpdatePatch) {
    if (!taskId) return;
    void store.update(taskId, patch).catch((err) => toastError("save task", err));
  }

  async function refresh() {
    if (!taskId || !projectCwd || refreshing) return;
    refreshing = true;
    try {
      await store.loadDetails(taskId, projectCwd, { refresh: true });
    } catch (err) {
      toastError("refresh issue", err);
    } finally {
      refreshing = false;
    }
  }

  async function comment(body: string) {
    if (!taskId) return;
    try {
      await store.comment(taskId, body);
    } catch (err) {
      toastError("post comment", err);
      throw err;
    }
  }

  function addLink(input: TaskLinkInput) {
    if (!taskId) return;
    void store.link(taskId, input).catch((err) => toastError("link this", err));
  }

  function removeLink(link: TaskLink) {
    void store
      .unlink(link.taskId, link.kind, link.targetKey, link.targetScope)
      .catch((err) => toastError("unlink this", err));
  }

  /** A linked row opens wherever that kind lives. */
  function openLink(link: TaskLink) {
    switch (link.kind) {
      case "work":
        void session.openWorkModal(link.targetKey, link.liveTitle || link.title);
        break;
      case "plan":
        void session.openPlanModal(`${link.targetScope}__${link.targetKey}`);
        break;
      case "automation":
        session.openAutomationBuilder(link.targetKey);
        break;
      case "pr": {
        const number = Number(link.targetKey);
        if (Number.isFinite(number)) {
          void session.enterPrReview(number, link.title, {
            ctx: link.targetScope ? session.ctxForDirectory(link.targetScope) : session.ctx,
          });
        }
        break;
      }
    }
  }

  /** Focus the session's tab when it's already open, otherwise resume it from
   *  history. Resolve the indexed record first: the link stores a session id,
   *  not which agent backend wrote it. */
  async function reveal(sessionId: string): Promise<string | null> {
    const openTab = findOpenTabForSession(
      sessionId,
      session.tabs,
      session.sessions,
      session.tabOrder,
    );
    if (openTab) return openTab;
    const meta = await window.solus.getSessionInfo(sessionId).catch(() => null);
    return meta ? await session.resumeSession(meta) : null;
  }

  async function openSession(sessionId: string) {
    const tabId = await reveal(sessionId);
    if (!tabId) return;
    session.selectTab(tabId);
    session.router.closeGroup("page");
  }

  async function openSessionSplit(sessionId: string) {
    const tabId = await reveal(sessionId);
    if (tabId) session.openSplitChat(tabId);
  }

  async function stopSession(sessionId: string) {
    try {
      await window.solus.stopSession(sessionId);
    } catch (err) {
      toastError("stop session", err);
    }
  }

  // Shares the Tasks scope: `task` and `tasks` are one exclusive page group, so
  // only ever one of them is mounted and Escape means the same thing in both.
  useScope("tasks", { active: () => true });
  useKeybinding("tasks.close", () => pane.close());
</script>

<div
  class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-[12.5px]"
  role="dialog"
  aria-label="Task"
  tabindex="-1"
>
  {#if task}
    <TaskChromeBar
      {task}
      {projectLabel}
      onPrevious={previous ? () => session.goToTask(previous.id, "click") : null}
      onNext={next ? () => session.goToTask(next.id, "click") : null}
      onOpenSource={task.url ? () => void window.solus.openExternal(task.url!) : null}
      onRefresh={task.providerId === "github" ? refresh : null}
      {refreshing}
      onOpenList={() => session.openTasks("click")}
      onClose={() => pane.close()}
    />

    <div
      class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:w-0"
    >
      <div class="mx-auto flex w-full max-w-[1420px] items-start gap-[34px] px-[52px] pt-6">
        <div class="flex min-w-0 flex-1 flex-col">
          <TaskHeader
            {task}
            canEdit={capabilities?.canEditContent ?? false}
            onSaveTitle={(title) => save({ title })}
            onSaveBody={(body) => save({ body })}
          />

          <TaskLinkedTable
            {links}
            onOpen={openLink}
            onUnlink={removeLink}
            onAdd={() => (picking = true)}
          />

          {#if sessions.length}
            <TaskSessionsList
              {sessions}
              onOpen={openSession}
              onOpenSplit={openSessionSplit}
              onStop={stopSession}
              onNewSession={() => void session.openTaskSession(task)}
            />
          {/if}

          <TaskActivityFeed comments={details?.comments ?? []} events={details?.events ?? []} />

          {#if capabilities?.canComment}
            <TaskCommentComposer onSubmit={comment} />
          {/if}
        </div>

        <TaskSidebar
          {task}
          {projectLabel}
          canEdit={capabilities?.canEditContent ?? false}
          canEditPlanningFields={capabilities?.canEditPlanningFields ?? false}
          onSave={save}
        />
      </div>
    </div>
  {:else}
    <div class="flex flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
      {store.loaded ? "That task no longer exists." : "Loading…"}
    </div>
  {/if}
</div>

{#if picking}
  <TaskLinkPicker {projectCwd} onPick={addLink} onClose={() => (picking = false)} />
{/if}
