<script lang="ts">
  import { ArrowRightIcon, PlugIcon, WarningCircleIcon } from "phosphor-svelte";
  import { getWorkspaceContext } from "../../contexts/workspace.context.svelte";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { STATUS_META, statusLabel, sortTasks } from "../tasks/lib/tasks-api";
  import {
    TASKS_AUTH_ERROR_PREFIX,
    type Task,
    type TaskProviderStatus,
  } from "../../../shared/task-types";

  interface Props {
    cwd: string | undefined;
    /** Panel visibility — the panel stays mounted while hidden, so only load
     *  the list when it's actually on screen (mirrors the old notes load). */
    active: boolean;
  }
  let { cwd, active }: Props = $props();

  const session = getWorkspaceContext();
  const store = session.tasksStore;
  let providerStatus = $state<TaskProviderStatus | null>(null);

  // Load once per project when the panel is visible. The store is shared with
  // the full Tasks page and guards stale loads, so re-entering a loaded project
  // is a no-op rather than a refetch.
  $effect(() => {
    if (!active || !cwd) return;
    const currentCwd = cwd;
    void window.solus.tasksProviderStatus(currentCwd).then((status) => {
      if (cwd === currentCwd) providerStatus = status;
    });
    if (store.cwd !== currentCwd) void store.load(currentCwd);
  });

  // Surface what's actionable, ranked for a glance: active work (in-progress)
  // first, then "what's next" — priority, then soonest due, then recency, via the
  // shared task sorter. Capped so the panel stays a quick overview, with the
  // remainder reachable through "View all".
  const MAX_ROWS = 3;
  const openTasks = $derived(store.tasks.filter((t) => t.status !== "done"));
  const ranked = $derived([
    ...sortTasks(
      openTasks.filter((t) => t.status === "in_progress"),
      "priority",
    ),
    ...sortTasks(
      openTasks.filter((t) => t.status === "open"),
      "priority",
    ),
  ]);
  const visible = $derived(ranked.slice(0, MAX_ROWS));
  const isStale = $derived(store.cwd !== cwd);

  function openTask(task: Task) {
    session.ui.openTasksToTask(task.id);
    requestInputFocus();
  }

  function openAll() {
    session.ui.openTasks();
    requestInputFocus();
  }

  function retry() {
    if (cwd && !store.loading) void store.load(cwd);
    requestInputFocus();
  }

  function openProjectSettings() {
    if (cwd) session.showProjectSettings(cwd);
    requestInputFocus();
  }

  function openGitProviders() {
    session.showSettings("git-providers");
    requestInputFocus();
  }

  const displayError = $derived(
    store.error ? store.error.replace(TASKS_AUTH_ERROR_PREFIX, "") : null,
  );
  const isAuthError = $derived(
    !!store.error && store.error.includes(TASKS_AUTH_ERROR_PREFIX),
  );
</script>

{#if (store.loading && !store.loaded) || isStale}
  <p class="m-0 py-0.5 text-[0.6875rem] text-(--solus-text-tertiary)">Loading tasks…</p>
{:else if store.error}
  <div class="flex flex-col gap-1 rounded-[0.4375rem] px-2 py-2">
    <div class="flex items-start gap-1.5 text-[0.6875rem] text-(--solus-status-error)">
      <WarningCircleIcon size={12} class="mt-px shrink-0" />
      <span class="leading-snug">{providerStatus?.ok === false ? providerStatus.message : displayError}</span>
    </div>
    <div class="flex items-center gap-1">
      {#if isAuthError || providerStatus?.reason === "github_not_connected"}
        <button
          type="button"
          class="inline-flex cursor-pointer items-center gap-1 rounded-[0.375rem] border-0 bg-(--solus-accent-light) px-2 py-1 text-[0.6875rem] font-medium text-(--solus-accent)"
          onclick={openGitProviders}
        >
          <PlugIcon size={11} />
          Connect
        </button>
      {:else if providerStatus?.reason === "missing_github_repo"}
        <button
          type="button"
          class="inline-flex cursor-pointer items-center rounded-[0.375rem] border-0 bg-(--solus-accent-light) px-2 py-1 text-[0.6875rem] font-medium text-(--solus-accent)"
          onclick={openProjectSettings}
        >
          Fix repo
        </button>
      {:else}
        <button
          type="button"
          class="inline-flex cursor-pointer items-center rounded-[0.375rem] border-0 bg-(--solus-accent-light) px-2 py-1 text-[0.6875rem] font-medium text-(--solus-accent)"
          onclick={retry}
        >
          Retry
        </button>
      {/if}
      <button
        type="button"
        class="inline-flex cursor-pointer items-center rounded-[0.375rem] border-0 bg-transparent px-2 py-1 text-[0.6875rem] font-medium text-(--solus-text-tertiary) hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary)"
        onclick={openAll}
      >
        View
      </button>
    </div>
  </div>
{:else if openTasks.length === 0}
  <button
    type="button"
    class="flex w-full cursor-pointer flex-col items-start gap-1 rounded-[0.4375rem] border-none bg-transparent px-2 py-2 text-left transition-colors duration-150 hover:bg-(--solus-accent-light) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
    onclick={openAll}
  >
    <span class="text-[0.8125rem] text-(--solus-text-secondary)">No open tasks</span>
    <span class="text-[0.6875rem] text-(--solus-text-tertiary)">View all tasks or create one.</span>
  </button>
{:else}
  <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
    {#each visible as task (task.id)}
      <li>
        <button
          type="button"
          class="group flex min-h-[2rem] w-full cursor-pointer items-center gap-2 rounded-[0.4375rem] border-none bg-transparent px-2 py-[0.3125rem] text-left transition-colors duration-150 hover:bg-(--solus-accent-light) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
          onclick={() => openTask(task)}
          title={statusLabel(task.status)}
        >
          <span
            class="size-2 shrink-0 rounded-full {STATUS_META[task.status]?.dotClass}"
            aria-hidden="true"
          ></span>
          <span
            class="min-w-0 flex-1 truncate text-[0.8125rem] font-normal text-(--solus-text-secondary) transition-colors duration-150 group-hover:text-(--solus-text-primary)"
          >
            {task.title || "Untitled task"}
          </span>
        </button>
      </li>
    {/each}
  </ul>
  <button
    type="button"
    class="mt-px flex w-full cursor-pointer items-center gap-1 rounded-[0.4375rem] border-none bg-transparent px-2 py-1.5 text-left text-[0.6875rem] font-normal text-(--solus-text-tertiary) transition-colors duration-150 hover:bg-(--solus-accent-light) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
    onclick={openAll}
  >
    View all {ranked.length}
    <ArrowRightIcon size={11} />
  </button>
{/if}
