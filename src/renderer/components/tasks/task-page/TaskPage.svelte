<script lang="ts">
  import type {
    Task,
    TaskLink,
    TaskLinkInput,
    TaskUpdatePatch,
  } from "../../../../shared/task-types";
  import {
    getProjectConfigStore,
    getWindowContext,
    getWorkspaceContext,
  } from "../../../contexts";
  import { findOpenTabForSession } from "../../../lib/sessionUtils";
  import { toasts } from "../../../lib/toasts";
  import { localApi } from "@client-core/local-api";
  import { serverConnections } from "@client-core/server-connections";
  import { LOCAL_SERVER_ID } from "@client-core/server-registry";
  import { resolveSessionMetaRef } from "@client-core/session-meta";
  import { setMarkdownImageContext } from "../../conversation/lib/markdown-image";
  import {
    useKeybinding,
    useScope,
  } from "../../../lib/keybindings/use-keybinding.svelte";
  import { paneActions } from "../../ui/lib/pane-actions.svelte";
  import type { RouteSurfaceProps } from "../../ui/lib/pane-surface";
  import { sortTasks } from "../lib/tasks-api";
  import { taskPageCapabilities } from "./lib/task-page";
  import {
    heldBackCommentIds,
    taskPublishTarget,
    taskUpstreamState,
  } from "./lib/task-upstream";
  import { taskPrRows } from "./lib/task-prs";
  import { LinkedPrsStore } from "./lib/linked-prs.store.svelte";
  import { linkedPrNavigationTarget } from "./lib/linked-pr-navigation";
  import TaskActivityFeed from "./TaskActivityFeed.svelte";
  import TaskPrList from "./TaskPrList.svelte";
  import TaskChromeBar from "./TaskChromeBar.svelte";
  import TaskCommentComposer from "./TaskCommentComposer.svelte";
  import TaskHeader from "./TaskHeader.svelte";
  import TaskLinkPicker from "./TaskLinkPicker.svelte";
  import TaskLinkedTable from "./TaskLinkedTable.svelte";
  import TaskSessionsList from "./TaskSessionsList.svelte";
  import TaskSidebar from "./TaskSidebar.svelte";

  let {
    params,
    paneId,
    surfaceVisible = true,
  }: RouteSurfaceProps<"task"> = $props();

  const session = getWorkspaceContext();
  const windowCtx = getWindowContext();
  const store = session.tasksStore;
  const projectConfig = getProjectConfigStore();
  const outbox = session.outboxStore;
  const pane = paneActions(paneId);

  const taskId = $derived(params.taskId);
  // Writes an agent recorded on another host that have not landed here yet
  // (ADR-0007). While any exist, this page is behind by exactly that much and
  // says so rather than passing stale state off as current.
  const syncOps = $derived(taskId ? outbox.pendingOpsFor("tasks", taskId) : []);
  const failedSyncCount = $derived(
    syncOps.filter((op) => op.state === "failed").length,
  );
  const pendingSyncCount = $derived(syncOps.length - failedSyncCount);
  const task = $derived(store.taskForId(taskId));
  const details = $derived(store.detailsFor(taskId));
  const links = $derived(details?.links ?? []);
  const sessions = $derived(store.sessionsByTask.get(taskId) ?? []);
  const projectCwd = $derived(
    task?.projectKey ?? session.tasksProjectCwd ?? undefined,
  );
  setMarkdownImageContext({
    cwd: () => projectCwd,
    serverId: () => store.hostFor(taskId) ?? LOCAL_SERVER_ID,
    ctx: () => projectCwd ? session.ctxForDirectory(projectCwd) : undefined,
    isWeb: () => windowCtx.isWeb,
  });
  const projectLabel = $derived(
    projectCwd ? (projectCwd.split("/").pop() ?? projectCwd) : "Inbox",
  );
  const capabilities = $derived(task ? taskPageCapabilities(task) : null);
  const upstream = $derived(
    task
      ? taskUpstreamState({
          task,
          externalLink: details?.externalLink,
          comments: details?.comments ?? [],
        })
      : null,
  );

  // PR state is a provider round trip the host deliberately keeps off the task
  // read, so the page overlays it here — from the shared PR caches, never from
  // the PRs page's own list, which belongs to whichever project it is showing.
  const linkedPrs = new LinkedPrsStore(session.prsStore);
  const taskServerId = $derived(store.hostFor(taskId));
  const prRows = $derived(
    taskPrRows(links, (number) =>
      linkedPrs.lifecycleFor(taskServerId, projectCwd, number),
    ),
  );
  $effect(() => {
    const serverId = taskServerId;
    const root = projectCwd;
    const numbers = prRows.map((row) => row.number);
    if (!serverId || !root || !numbers.length) return;
    linkedPrs.ensure(
      {
        api: serverConnections.apiFor(serverId),
        serverId,
        projectRoot: root,
        ctx: session.ctxForDirectory(root),
      },
      numbers,
    );
  });

  // Auto-post is a project decision, not a per-task one: it is the same choice
  // for every ticket filed against this repo, and it already lives in the
  // project config the Tasks page writes.
  const configHost = $derived(
    taskServerId
      ? { serverId: taskServerId, api: serverConnections.apiFor(taskServerId) }
      : null,
  );
  const autoPost = $derived(
    upstream?.canSync && taskServerId && projectCwd
      ? (projectConfig.configFor(taskServerId, projectCwd)?.tasksAutoPushComments ?? false)
      : null,
  );
  const heldBack = $derived(
    heldBackCommentIds(details?.comments ?? [], !!upstream?.canSync),
  );
  const providerStatus = $derived(store.providerStatus(projectCwd));
  const publishTarget = $derived(
    task ? taskPublishTarget({ task, upstream, status: providerStatus }) : null,
  );

  // Both reads answer "where could this task be filed, and what happens to a
  // comment when it is": the page cannot draw its sync controls without them.
  $effect(() => {
    const host = configHost;
    const cwd = projectCwd;
    if (!host || !cwd) return;
    if (projectConfig.configFor(host.serverId, cwd) === undefined) {
      void projectConfig.load(host, cwd).catch(() => {});
    }
    if (!store.providerStatus(cwd)) {
      void store.loadProviderStatus(cwd, { serverId: host.serverId }).catch(() => {});
    }
  });

  let picking = $state(false);
  let refreshing = $state(false);
  let syncing = $state(false);

  // The route param is the request: whenever it names a task we haven't read the
  // detail of, fetch it. A $derived can't express "go do IO", so this is one of
  // the cases $effect is actually for.
  let loadedId: string | null = null;
  $effect(() => {
    const id = taskId;
    if (!id || !surfaceVisible) {
      loadedId = null;
      return;
    }
    const stopWatching = store.watchDetails(id);
    if (id !== loadedId) {
      loadedId = id;
      void store.ensureLoaded().catch(() => {});
      void store
        .loadDetails(id, projectCwd)
        .catch((err) => toastError("open task", err));
    }
    return stopWatching;
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
    position >= 0 && position < siblings.length - 1
      ? siblings[position + 1]
      : null,
  );

  function toastError(action: string, err: Parameters<typeof String>[0]) {
    toasts.error(`Couldn't ${action}`, {
      description: err instanceof Error ? err.message : String(err),
    });
  }

  function save(patch: TaskUpdatePatch) {
    if (!taskId) return;
    void store
      .update(taskId, patch)
      .catch((err) => toastError("save task", err));
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

  /** Exchange with the ticket now rather than on the engine's own debounce. */
  async function syncNow() {
    if (!taskId || syncing) return;
    syncing = true;
    try {
      await store.syncNow(taskId);
    } catch (err) {
      toastError("sync with the provider", err);
    } finally {
      syncing = false;
    }
  }

  async function comment(body: string, alsoPost: boolean) {
    if (!taskId) return;
    try {
      await store.comment(taskId, body, { pushToExternal: alsoPost });
    } catch (err) {
      toastError("post comment", err);
      throw err;
    }
  }

  async function publishComments(commentIds: string[]) {
    if (!taskId || !commentIds.length) return;
    try {
      await store.publishComments(taskId, commentIds);
    } catch (err) {
      toastError("publish that comment", err);
    }
  }

  /** File this task with the project's provider for the first time. */
  async function publishTask() {
    if (!taskId || !projectCwd || syncing) return;
    syncing = true;
    try {
      await store.publishUpstream(taskId, projectCwd);
    } catch (err) {
      toastError("publish this task", err);
    } finally {
      syncing = false;
    }
  }

  function setAutoPost(next: boolean) {
    const host = configHost;
    if (!host || !projectCwd) return;
    void projectConfig
      .save(host, projectCwd, { tasksAutoPushComments: next })
      .catch((err) => toastError("save the auto-post setting", err));
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
        void session.openWorkModal(
          link.targetKey,
          link.liveTitle || link.title,
          { secondary: true, via: "click" },
        );
        break;
      case "plan":
        void session.openPlanModal(
          `${link.targetScope}__${link.targetKey}`,
          undefined,
          { secondary: true },
        );
        break;
      case "automation":
        session.openAutomationBuilder(link.targetKey, "aside");
        break;
      case "pr": {
        const number = Number(link.targetKey);
        if (Number.isFinite(number)) {
          const target = linkedPrNavigationTarget({
            taskServerId: store.hostFor(taskId),
            taskProjectDirectory: projectCwd,
            linkProjectDirectory: link.targetScope,
          });
          void session.enterPrReview(number, link.title, {
            ctx: target.projectDirectory
              ? session.ctxForDirectory(target.projectDirectory)
              : session.ctx,
            serverId: target.serverId,
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
    const link = store.sessionsByTask.get(taskId)?.find((candidate) => candidate.sessionId === sessionId);
    const serverId = link?.executionServerId ?? store.hostFor(taskId);
    const openTab = findOpenTabForSession(
      sessionId,
      session.tabs,
      session.sessions,
      session.tabOrder,
      undefined,
      serverId ? serverConnections.resolveId(serverId) : undefined,
    );
    if (openTab) return openTab;
    const meta = await resolveSessionMetaRef({ sessionId, serverId });
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
    const revealed = tabId ? session.sessionFor(tabId) : undefined;
    if (revealed) session.openSplitChat(revealed.id);
  }

  function unlinkSession(sessionId: string) {
    void store
      .unlinkSession(taskId, sessionId)
      .catch((err) => toastError("unlink this session", err));
  }

  async function stopSession(sessionId: string) {
    try {
      const serverId = store.hostFor(taskId);
      const api = serverId
        ? serverConnections.apiFor(serverId)
        : serverConnections.primaryApi();
      await api.stopSession(sessionId);
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
  class="@container relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-[0.8125rem]"
  role="dialog"
  aria-label="Task"
  tabindex="-1"
>
  {#if task}
    <TaskChromeBar
      {task}
      {projectLabel}
      projectRoot={projectCwd}
      {upstream}
      syncing={syncing || refreshing}
      onSync={upstream?.canSync
        ? syncNow
        : task.providerId === "github"
          ? refresh
          : null}
      onPrevious={previous
        ? () => session.goToTask(previous.id, "click")
        : null}
      onNext={next ? () => session.goToTask(next.id, "click") : null}
      onOpenSource={task.url
        ? () => void localApi.openExternal(task.url!)
        : null}
      onOpenList={() => session.openTasks("click")}
      onClose={() => pane.close()}
    />

    <div
      class="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:w-0"
    >
      {#if syncOps.length}
        <div class="mx-auto w-full max-w-[1420px] px-[52px] pt-4">
          <div
            class="flex items-center gap-2 rounded-md border-[.5px] border-[var(--hairline)] bg-[var(--wash-1)] px-3 py-2 text-xs text-muted-foreground"
            role="status"
          >
            <span
              class="size-1.5 shrink-0 rounded-full {failedSyncCount
                ? 'bg-red-500'
                : 'bg-amber-500'}"
              aria-hidden="true"
            ></span>
            {#if pendingSyncCount}
              <span
                >{pendingSyncCount} update{pendingSyncCount === 1 ? "" : "s"} from
                a dispatched session waiting to sync</span
              >
            {/if}
            {#if failedSyncCount}
              <span
                >{failedSyncCount} update{failedSyncCount === 1 ? "" : "s"} failed
                to sync</span
              >
            {/if}
          </div>
        </div>
      {/if}
      <div
        class="mx-auto flex w-full max-w-[1420px] items-start gap-[34px] px-[52px] pt-6"
      >
        <div class="flex min-w-0 flex-1 flex-col">
          <TaskHeader
            {task}
            canEdit={capabilities?.canEditContent ?? false}
            onSaveTitle={(title) => save({ title })}
            onSaveBody={(body) => save({ body })}
          />

          {#if prRows.length}
            <TaskPrList
              rows={prRows}
              onOpen={openLink}
              onOpenExternal={(url) => void localApi.openExternal(url)}
              onUnlink={removeLink}
              onAdd={() => (picking = true)}
            />
          {/if}

          <TaskLinkedTable
            {links}
            onOpen={openLink}
            onUnlink={removeLink}
            onAdd={() => (picking = true)}
          />

          {#if sessions.length}
            <TaskSessionsList
              {sessions}
              taskTitle={task.title}
              onOpen={openSession}
              onOpenSplit={openSessionSplit}
              onStop={stopSession}
              onUnlink={unlinkSession}
              onNewSession={() => void session.openTaskSession(task)}
            />
          {/if}

          <TaskActivityFeed
            comments={details?.comments ?? []}
            events={details?.events ?? []}
            provider={upstream?.canSync ? upstream.provider : null}
            onPublish={(commentId) => publishComments([commentId])}
          />

          {#if capabilities?.canComment}
            <TaskCommentComposer
              onSubmit={comment}
              provider={upstream?.canSync ? upstream.provider : null}
              autoPost={autoPost ?? false}
            />
          {/if}
        </div>

        <TaskSidebar
          {task}
          {projectLabel}
          projectRoot={projectCwd}
          canEdit={capabilities?.canEditContent ?? false}
          canEditPlanningFields={capabilities?.canEditPlanningFields ?? false}
          {upstream}
          {publishTarget}
          {syncing}
          {autoPost}
          onSyncNow={syncNow}
          onSetAutoPost={setAutoPost}
          onPublishAll={() => void publishComments(heldBack)}
          onPublishTask={publishTask}
          onOpenUpstream={(url) => void localApi.openExternal(url)}
          onSave={save}
        />
      </div>
    </div>
  {:else}
    <div
      class="flex flex-1 items-center justify-center text-[0.8125rem] text-muted-foreground"
    >
      {store.loaded ? "That task no longer exists." : "Loading…"}
    </div>
  {/if}
</div>

{#if picking}
  <TaskLinkPicker
    {projectCwd}
    onPick={addLink}
    onClose={() => (picking = false)}
  />
{/if}
