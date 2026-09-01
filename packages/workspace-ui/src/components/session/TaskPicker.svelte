<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import {
    ChevronDown as CaretDownIcon,
    Clock as ClockIcon,
    ExternalLink as ArrowSquareOutIcon,
    ListChecks as ListChecksIcon,
    Search as MagnifyingGlassIcon,
    Moon as MoonIcon,
    Sun as SunIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import { localApi } from "@solus/client-core/local-api";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
  import {
    getSessionSidebarStore,
    getWorkspaceContext,
    getPullRequestsContext,
    runtime,
  } from "../../contexts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { toasts } from "../../lib/toasts";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import * as DropdownMenu from "../ui/dropdown-menu";
  import { Input } from "../ui/input";
  import Kbd from "../ui/Kbd.svelte";
  import TaskContextMenu from "./TaskContextMenu.svelte";
  import TaskStatusGlyph from "../tasks/TaskStatusGlyph.svelte";
  import { TASK_SNOOZE_CHOICES, taskSnoozeUntil } from "./lib/task-snooze";
  import { relativeTime, STATUS_META, TASK_STATUSES } from "../tasks/lib/tasks-api";
  import { taskPickerSections } from "../tasks/lib/task-picker-sections";
  import { isDone } from "../tasks/lib/tasks-list-view";
  import {
    linkedTableLinks,
    linkRow,
    priorityBars,
    priorityLabel,
    statusTextColor,
  } from "../tasks/task-page/lib/task-page";
  import { prStatusBadge } from "../prs/lib/pr-utils";
  import { prLifecycleOf } from "../tasks/task-page/lib/task-prs";
  import {
    previewPrGlyph,
    previewPrRows,
    TaskPreviewDetails,
  } from "./lib/task-preview.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    inline?: boolean;
  }

  let { open = $bindable(), onClose, inline = false }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();
  const sidebarStore = getSessionSidebarStore();
  const layer = getPopoverLayer();
  let query = $state("");
  let selectedIndex = $state(0);
  let searchEl = $state<HTMLInputElement | null>(null);
  let pickerEl = $state<HTMLDivElement | null>(null);
  let wasOpen = false;

  let taskContextMenu = $state<{ task: Task; x: number; y: number } | null>(null);

  // Newest work first, and the row now states the date it is sorted by, so the
  // order is readable rather than something you have to take on trust.
  const tasks = $derived(
    sidebarStore.pickableTasks.toSorted(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    ),
  );
  const filteredTasks = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return tasks;
    return tasks.filter((task) =>
      [task.title, task.body, task.shortId, task.id, task.projectKey, task.status]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  });
  const taskSections = $derived(taskPickerSections(filteredTasks));
  const visibleTasks = $derived(taskSections.flatMap((section) => section.tasks));
  const selectedTask = $derived(
    visibleTasks[Math.min(selectedIndex, visibleTasks.length - 1)] ?? null,
  );

  // Works, plans and automations only come from a detail read, so the preview
  // asks for them once the selection settles and shows no Linked section until
  // they arrive. PRs need no read: the sidebar snapshot already carries them.
  const previewDetails = new TaskPreviewDetails((taskId, projectKey) =>
    session.tasksStore.get(taskId, projectKey).loadDetails(),
  );
  const links = $derived(
    selectedTask ? session.tasksStore.get(selectedTask.id).details?.links ?? [] : [],
  );
  const linkedRows = $derived(linkedTableLinks(links).map(linkRow));
  // A PR's state and title are a provider round trip the picker deliberately
  // does not make: both appear when some other surface has already read that
  // PR, and the row renders from its link snapshot otherwise rather than
  // inventing a state or a name.
  const prScope = $derived({
    cwd: selectedTask?.projectKey ?? null,
    serverId: selectedTask ? session.tasksStore.get(selectedTask.id).serverId : null,
  });
  const prRows = $derived(
    previewPrRows(
      links,
      selectedTask ? session.tasksStore.get(selectedTask.id).prLink : null,
      (number) =>
        prLifecycleOf(pullRequests.projects.at(prScope.serverId, prScope.cwd)?.prFor(number) ?? null),
      (number) =>
        pullRequests.projects.at(prScope.serverId, prScope.cwd)?.prFor(number)?.title || undefined,
    ),
  );

  $effect(() => {
    if (!open || !selectedTask) return;
    previewDetails.request(selectedTask.id, selectedTask.projectKey ?? undefined);
    return () => previewDetails.cancel();
  });
  $effect(() => {
    void query;
    selectedIndex = 0;
  });

  $effect(() => {
    if (!open) {
      wasOpen = false;
      return;
    }
    if (wasOpen) return;
    wasOpen = true;
    query = "";
    selectedIndex = 0;
    void session.tasksStore.ensureLoaded();
    blurActiveTextInputOnMobile();
    tick().then(() => {
      if (!runtime.shouldSuppressFocus) searchEl?.focus();
      else pickerEl?.focus();
    });
  });

  function close(): void {
    taskContextMenu = null;
    open = false;
    onClose();
    requestAnimationFrame(() => blurActiveTextInputOnMobile());
  }

  function select(task: Task): void {
    window.dispatchEvent(
      new CustomEvent("solus:expand-sidebar-task", { detail: task.id }),
    );
    void sidebarStore.selectTaskRecord(task);
    close();
  }

  function projectLabel(task: Task): string {
    if (!task.projectKey) return "Inbox";
    return task.projectKey.replace(/\/$/, "").split("/").at(-1) || task.projectKey;
  }

  // The picker portals into the popover layer, which sits at z-index 10010 —
  // above every menu's own z-index at body level. A menu summoned from inside
  // the picker must therefore portal into that same layer, or it mounts, opens,
  // and paints underneath the picker's backdrop where nothing can reach it.
  const menuPortalProps = $derived({ to: layer.el ?? undefined });

  // ── Managing a task without leaving the picker ──
  // Every move below is the same one the sidebar's row menu makes, on the same
  // store calls, so a task looks identical whichever surface changed it. The
  // picker stays open for status, snooze and unread — they are edits to a row
  // you are still choosing between — and closes for anything that navigates.

  function hasLinkedSession(task: Task): boolean {
    return (session.tasksStore.get(task.id).sessions.length) > 0;
  }

  /** Snoozing a picker row is the sidebar's own row snooze, keyed by task id. */
  function isSnoozed(task: Task): boolean {
    return sidebarStore.snoozedTasks.some((row) => row.taskId === task.id);
  }

  function openTaskPage(task: Task): void {
    const taskId = task.id;
    close();
    session.goToTask(taskId);
  }

  function resumeTask(task: Task): void {
    close();
    void session.openTaskLinkedSession(task);
  }

  function openSourceTicket(task: Task): void {
    if (!task.url) return;
    close();
    void localApi.openExternal(task.url);
  }

  async function setStatus(task: Task, status: TaskStatus): Promise<void> {
    try {
      await session.tasksStore.get(task.id, task.projectKey ?? undefined).setStatus(status);
    } catch (error) {
      toasts.error("Couldn't update status", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function snooze(task: Task, until: number | null): void {
    sidebarStore.snoozeRow(task.id, until);
  }

  function deleteTask(task: Task): void {
    const pending = session.tasksStore.softRemove([task.id]);
    if (!pending.length) return;
    toasts.undo("Task deleted", () => session.tasksStore.restorePending(pending), {
      onDismiss: () =>
        session.tasksStore.commitPending(pending).catch((error) =>
          toasts.error("Couldn't delete task", {
            description: error instanceof Error ? error.message : String(error),
          })),
    });
  }

  // Touch has no right click, and on mobile the preview pane is hidden — so the
  // long press is the only way a phone reaches these actions at all.
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressNextClick = false;

  function openContextMenu(event: MouseEvent | PointerEvent, task: Task, index: number): void {
    event.preventDefault();
    event.stopPropagation();
    selectedIndex = index;
    taskContextMenu = { task, x: event.clientX, y: event.clientY };
  }

  function startLongPress(event: PointerEvent, task: Task, index: number): void {
    if (event.pointerType !== "touch") return;
    longPressTimer = setTimeout(() => {
      suppressNextClick = true;
      openContextMenu(event, task, index);
    }, 500);
  }

  function cancelLongPress(): void {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    // While the row menu is up it owns the keyboard, including the Escape that
    // dismisses it — arrowing the list underneath it would move the selection
    // away from the task the open menu is acting on.
    if (taskContextMenu) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, visibleTasks.length - 1);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (event.key === "Enter" && selectedTask) {
      event.preventDefault();
      select(selectedTask);
    }
  }

  /**
   * Dismiss by the scrim, not by a document listener.
   *
   * A document-level "was this click outside the panel?" test is wrong for this
   * picker, because everything the picker opens — the row menu, the status and
   * snooze dropdowns, every submenu — portals into the popover layer and is
   * therefore outside the panel by construction. Gating that listener on the
   * menu's open state left the answer depending on the order of `mousedown`,
   * `click`, the menu's own close, and the effect that re-arms the listener,
   * and a menu action ended up dismissing the picker under it.
   *
   * The scrim already exists to be the click-away target, so it can answer the
   * question directly and unambiguously: a press that lands on the scrim itself
   * — not on a child, and not on a menu that is the scrim's sibling — is a
   * press outside the picker. Nothing about a menu's event sequence can reach
   * it, and there is no listener to arm or disarm.
   */
  function handleScrimPointerDown(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    close();
  }
</script>

{#snippet sectionHeading(label: string, count: number)}
  <div
    class="flex h-8 items-center gap-1.5 px-3 text-(--solus-text-tertiary) max-md:h-[30px] max-md:px-4"
  >
    <span class="text-xs font-normal uppercase max-md:tracking-[0.12em]"
      >{label}</span
    >
    <span class="text-xs tabular-nums opacity-70">{count}</span>
  </div>
{/snippet}

{#snippet taskRow(task: Task, index: number, done: boolean)}
  <button
    type="button"
    role="option"
    aria-selected={index === selectedIndex}
    class="flex h-[46px] w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-3 text-left transition-[background-color,color] duration-100 max-md:h-[62px] max-md:gap-[11px] max-md:rounded-xl {index === selectedIndex ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)' : 'text-(--solus-text-secondary) hover:bg-(--solus-surface-hover)'} {done ? 'opacity-60' : ''}"
    onclick={() => {
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      select(task);
    }}
    onpointerenter={() => (selectedIndex = index)}
    oncontextmenu={(event) => openContextMenu(event, task, index)}
    onpointerdown={(event) => startLongPress(event, task, index)}
    onpointerup={cancelLongPress}
    onpointercancel={cancelLongPress}
    onpointermove={cancelLongPress}
  >
    <ListChecksIcon
      size={14}
      class="shrink-0 text-(--solus-text-tertiary) max-md:hidden"
    />
    <!-- A thumb gets the state as well as the name: at 62px there is room for
         the status tile every other phone list row carries, and a task that is
         running is the one you were looking for. -->
    <span
      class="hidden size-7 shrink-0 items-center justify-center rounded-lg bg-[var(--wash-3)] text-(--solus-text-tertiary) max-md:flex"
      aria-hidden="true"
    >
      <TaskStatusGlyph status={task.status} size={15} />
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate font-medium max-md:text-sm">{task.title}</span>
      <span class="block truncate text-xs text-(--solus-text-tertiary)">{projectLabel(task)}</span>
    </span>
    <!-- The key the list is ordered by. Tabular figures so a column of dates
         never reflows the titles beside them as the values change width. -->
    <span class="shrink-0 text-xs tabular-nums text-(--solus-text-tertiary) opacity-70">
      {relativeTime(task.updatedAt)}
    </span>
  </button>
{/snippet}

{#snippet pickerContent()}
  <div
    class="relative flex h-12 flex-shrink-0 items-center gap-2.5 px-[1.125rem] after:absolute after:right-[1.125rem] after:bottom-0 after:left-[1.125rem] after:h-px after:bg-[var(--solus-popover-border)] after:opacity-35 after:content-[''] max-md:h-auto max-md:flex-col max-md:items-stretch max-md:gap-0 max-md:border-b max-md:border-[var(--hairline)] max-md:px-4 max-md:pt-1 max-md:pb-3 max-md:after:hidden"
  >
    <!-- The same search shape the phone uses everywhere else: a 48px card, not a
         bare rule. `display: contents` above the rung leaves the desktop row
         exactly as it was. -->
    <div
      class="contents max-md:flex max-md:h-12 max-md:items-center max-md:gap-2.5 max-md:rounded-lg max-md:bg-card max-md:px-3 max-md:shadow-[shadow:var(--elev-ring)]"
    >
      <MagnifyingGlassIcon
        size={14}
        class="shrink-0 text-(--solus-text-tertiary) max-md:size-4"
      />
      <Input
        bind:ref={searchEl}
        bind:value={query}
        type="text"
        placeholder={`Search ${tasks.length} tasks…`}
        class="h-auto flex-1 rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent max-md:text-base"
      />
      <button
        type="button"
        class="relative flex size-6 cursor-pointer items-center justify-center rounded-md text-(--solus-text-tertiary) transition-[background-color,color] duration-100 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) max-md:size-9 max-md:rounded-[0.625rem]"
        onclick={close}
        aria-label="Close task picker"
      >
        <XIcon size={14} />
      </button>
    </div>
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden max-md:overflow-visible">
    <div class="w-[clamp(20rem,42%,27.5rem)] shrink-0 overflow-y-auto overscroll-y-contain p-2 max-md:w-full max-md:px-3 max-md:pt-1.5" role="listbox">
      {#if filteredTasks.length === 0}
        <div class="flex h-full items-center justify-center px-5 text-center text-xs text-(--solus-text-tertiary)">
          {session.tasksStore.loading ? "Loading tasks…" : `No tasks match “${query}”`}
        </div>
      {:else}
        {#each taskSections as section (section.key)}
          {@render sectionHeading(section.label, section.tasks.length)}
          {#each section.tasks as task, index (task.id)}
            {@render taskRow(task, section.startIndex + index, isDone(task))}
          {/each}
        {/each}
      {/if}
    </div>
    <div class="relative min-w-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--solus-surface-primary)_5%,transparent)] p-7 shadow-[inset_0.0625rem_0_0_0_color-mix(in_srgb,var(--solus-popover-border)_45%,transparent)] max-md:hidden">
      {#if selectedTask}
        {@const status = STATUS_META[selectedTask.status]}
        {@const bars = priorityBars(selectedTask.priority)}
        {@const openedAt = selectedTask.createdAt ? relativeTime(selectedTask.createdAt) : ""}
        <div class="mx-auto flex max-w-xl flex-col">
          <div class="flex flex-wrap items-center gap-x-[13px] gap-y-1.5 pb-[11px] text-workspace-chrome leading-5">
            <span
              class="inline-flex h-5 items-center gap-1.5"
              style="color:{statusTextColor(selectedTask.status)}"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.45"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"><path d={status.glyph} /></svg
              >
              {status.label}
            </span>
            <span class="h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
            <span class="inline-flex h-5 items-center gap-1.5 text-(--solus-text-tertiary)">
              <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
                {#each bars as bar (bar.height)}
                  <span
                    class="w-[2.5px] rounded-[0.0625rem]"
                    style="height:{bar.height};background:{bar.background}"
                  ></span>
                {/each}
              </span>
              {priorityLabel(selectedTask.priority)}
            </span>
            <span class="h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
            <span class="inline-flex h-5 items-center text-(--solus-text-tertiary)">{projectLabel(selectedTask)}</span>
            {#if openedAt}
              <span class="h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
              <span class="inline-flex h-5 items-center text-(--solus-text-tertiary) opacity-75">opened {openedAt}</span>
            {/if}
          </div>
          <h2 class="m-0 text-2xl font-medium leading-[1.25] text-pretty text-(--solus-text-primary)">{selectedTask.title}</h2>
          {#if selectedTask.body}
            <p class="whitespace-pre-wrap text-pretty pt-[18px] leading-6 text-(--solus-text-secondary)">{selectedTask.body}</p>
          {:else}
            <p class="pt-[18px] text-(--solus-text-tertiary)">No task description.</p>
          {/if}
          {#if prRows.length}
            <div class="flex flex-col gap-[7px] pt-[26px]">
              <div class="flex items-center gap-2.5">
                <span class="text-xs font-normal uppercase text-(--solus-text-tertiary)">Pull requests</span>
                <span class="text-xs tabular-nums text-(--solus-text-tertiary) opacity-70">{prRows.length}</span>
                <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
              </div>
              <div class="overflow-hidden rounded-xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]">
                {#each prRows as row, index (row.key)}
                  {@const badge = prStatusBadge(row.state)}
                  {@const glyph = previewPrGlyph(row.state)}
                  {@const PrIcon = glyph.Icon}
                  <div class="flex items-center gap-[11px] py-2 pr-2.5 pl-[13px] {index ? 'border-t-[.5px] border-[var(--hairline)]' : ''}">
                    <span
                      class="flex size-3.5 shrink-0 items-center justify-center"
                      style="color:{glyph.tone}"
                      aria-hidden="true"
                    >
                      <PrIcon size={13} />
                    </span>
                    <span class="flex h-5 shrink-0 items-center text-xs tabular-nums text-(--solus-text-tertiary) opacity-65">{row.ref}</span>
                    <span class="flex h-5 min-w-0 flex-1 items-center truncate">
                      {#if row.title}
                        {row.title}
                      {:else}
                        <!-- Keeps the row's shape while the detail read that
                             carries the title is still in flight. -->
                        <span class="h-[9px] w-24 rounded-full bg-[var(--wash-2)]" aria-hidden="true"></span>
                      {/if}
                    </span>
                    {#if badge}
                      <span
                        class="flex h-5 shrink-0 items-center gap-1.5 rounded-full pr-2.5 pl-2 text-xs font-medium whitespace-nowrap"
                        style="color:{badge.tone};background:color-mix(in oklch, {badge.tone} 12%, transparent);box-shadow:0 0 0 .5px color-mix(in oklch, {badge.tone} 30%, transparent)"
                      >
                        <span class="size-[5px] shrink-0 rounded-full" style="background:{badge.tone}" aria-hidden="true"></span>
                        {badge.label}
                      </span>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          {#if linkedRows.length}
            <div class="flex flex-col gap-[7px] pt-[26px]">
              <div class="flex items-center gap-2">
                <span class="text-xs font-normal uppercase text-(--solus-text-tertiary)">Linked</span>
                <span class="text-xs tabular-nums text-(--solus-text-tertiary) opacity-70">{linkedRows.length}</span>
                <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
              </div>
              <div class="flex flex-col">
                {#each linkedRows as row (row.key)}
                  <div class="flex h-[33px] items-center gap-[11px] border-b-[.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] px-1">
                    <span class="flex size-3.5 shrink-0 items-center justify-center text-(--solus-text-tertiary) opacity-50">
                      <svg
                        width="12.5"
                        height="12.5"
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"><path d={row.icon} /></svg
                      >
                    </span>
                    <span class="min-w-0 flex-1 truncate">{row.label}</span>
                    <span class="w-[92px] shrink-0 text-xs whitespace-nowrap text-(--solus-text-tertiary) opacity-70">{row.kindLabel}</span>
                    <span class="w-[88px] shrink-0 truncate text-right text-xs whitespace-nowrap text-(--solus-text-tertiary) opacity-75">{row.meta}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- What you can do to this task without opening it. The two moves
               that navigate lead; the ones that only edit the row — status and
               snooze — leave the picker open, so you can triage a run of tasks
               in one visit. -->
          <div class="mt-6 flex flex-wrap items-center gap-2">
            <button
              type="button"
              class="flex h-7 cursor-pointer items-center rounded-lg bg-(--solus-accent-light) px-3 text-xs font-medium text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-(--solus-accent-soft) active:scale-[0.96]"
              onclick={() => select(selectedTask)}
            >Open new draft</button>
            {#if hasLinkedSession(selectedTask)}
              <button
                type="button"
                class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-(--solus-text-secondary) shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
                onclick={() => resumeTask(selectedTask)}
              >Resume session</button>
            {/if}
            <button
              type="button"
              class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-(--solus-text-secondary) shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
              onclick={() => openTaskPage(selectedTask)}
            >
              <ListChecksIcon size={13} class="shrink-0 opacity-70" />
              Open task
            </button>

            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <button {...props} type="button" class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-(--solus-text-secondary) shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" aria-label="Set task status">
                    <TaskStatusGlyph status={selectedTask.status} size={13} />
                    {status.label}
                    <CaretDownIcon size={9} class="shrink-0 opacity-60" />
                  </button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                class="min-w-40"
                portalProps={menuPortalProps}
              >
                {#each TASK_STATUSES as option (option)}
                  <DropdownMenu.Item onSelect={() => void setStatus(selectedTask, option)}>
                    <TaskStatusGlyph status={option} size={13} />
                    {STATUS_META[option].label}
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            {#if isSnoozed(selectedTask)}
              <button
                type="button"
                class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-(--solus-text-secondary) shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
                onclick={() => snooze(selectedTask, null)}
              >
                <SunIcon size={13} class="shrink-0 opacity-70" />
                Wake now
              </button>
            {:else}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger>
                  {#snippet child({ props })}
                    <button {...props} type="button" class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-(--solus-text-secondary) shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]" aria-label="Snooze task">
                      <MoonIcon size={13} class="shrink-0 opacity-70" />
                      Snooze
                      <CaretDownIcon size={9} class="shrink-0 opacity-60" />
                    </button>
                  {/snippet}
                </DropdownMenu.Trigger>
                <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                class="min-w-40"
                portalProps={menuPortalProps}
              >
                  {#each TASK_SNOOZE_CHOICES as choice (choice.preset)}
                    {@const ChoiceIcon = choice.isRelative ? ClockIcon : MoonIcon}
                    <DropdownMenu.Item
                      onSelect={() => snooze(selectedTask, taskSnoozeUntil(choice.preset))}
                    >
                      <ChoiceIcon size={13} class="shrink-0 opacity-70" />
                      {choice.label}
                    </DropdownMenu.Item>
                  {/each}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {/if}

            {#if selectedTask.url}
              <button
                type="button"
                class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-(--solus-text-secondary) shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-[background-color,color,scale] duration-150 hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96]"
                onclick={() => openSourceTicket(selectedTask)}
              >
                <ArrowSquareOutIcon size={13} class="shrink-0 opacity-70" />
                Source ticket
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <div class="flex h-8 shrink-0 items-center justify-between px-[1.125rem] text-xs text-(--solus-text-tertiary) max-md:h-9">
    <span class="tabular-nums">{filteredTasks.length === tasks.length ? `${tasks.length} tasks` : `${filteredTasks.length} of ${tasks.length}`}</span>
    <div class="flex items-center gap-3.5 max-md:hidden">
      <span class="inline-flex items-center gap-1"><Kbd variant="hint">↑</Kbd><Kbd variant="hint">↓</Kbd> navigate</span>
      <span class="inline-flex items-center gap-1"><Kbd variant="hint">↵</Kbd> open draft</span>
      <span class="inline-flex items-center gap-1"><Kbd variant="hint">esc</Kbd> close</span>
    </div>
  </div>
{/snippet}

{#if open && taskContextMenu}
  {@const menuTask = taskContextMenu.task}
  <TaskContextMenu
    x={taskContextMenu.x}
    y={taskContextMenu.y}
    task={menuTask}
    hasLinkedSession={hasLinkedSession(menuTask)}
    isRunning={false}
    onStart={() => select(menuTask)}
    onResume={hasLinkedSession(menuTask) ? () => resumeTask(menuTask) : undefined}
    onOpenTask={() => openTaskPage(menuTask)}
    onOpenSource={menuTask.url ? () => openSourceTicket(menuTask) : undefined}
    onSetStatus={(status) => void setStatus(menuTask, status)}
    onSnoozeUntil={isSnoozed(menuTask) ? undefined : (until) => snooze(menuTask, until)}
    onWake={isSnoozed(menuTask) ? () => snooze(menuTask, null) : undefined}
    onMarkUnread={() => void sidebarStore.markTaskUnread(menuTask.id)}
    onDelete={menuTask.providerId === "local" ? () => deleteTask(menuTask) : undefined}
    portalTarget={layer.el}
    onClose={() => (taskContextMenu = null)}
  />
{/if}

{#if open && inline}
  <div bind:this={pickerEl} class="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent outline-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown} transition:fly={{ y: 8, duration: 160 }}>
    {@render pickerContent()}
  </div>
{:else if open && layer.el}
  <div use:portal={layer.el} class="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] motion-safe:animate-[backdrop-fade_140ms_ease-out]" role="presentation" onmousedown={handleScrimPointerDown}>
    <div bind:this={pickerEl} class="flex h-3/4 max-h-[75%] w-4/5 origin-top flex-col overflow-hidden overscroll-contain rounded-2xl text-workspace-chrome border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] outline-none motion-safe:animate-[picker-enter_180ms_cubic-bezier(0.22,1,0.36,1)_backwards] [.is-laptop-display_&]:w-[90%] max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:rounded-none max-md:border-none max-md:bg-(--solus-container-bg) max-md:shadow-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown}>
      {@render pickerContent()}
    </div>
  </div>
{/if}
