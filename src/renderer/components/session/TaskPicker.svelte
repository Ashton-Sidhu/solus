<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import {
    ListChecksIcon,
    MagnifyingGlassIcon,
    XIcon,
  } from "phosphor-svelte";
  import type { Task } from "../../../shared/task-types";
  import {
    getSessionSidebarStore,
    getWorkspaceContext,
    runtime,
  } from "../../contexts";
  import { blurActiveTextInputOnMobile } from "../../lib/inputFocus";
  import { getPopoverLayer, useClickOutside } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import { Input } from "../ui/input";
  import Kbd from "../ui/Kbd.svelte";
  import {
    centringPadding,
    observeConversationBounds,
    type ConversationBounds,
  } from "../pickers/lib/conversation-bounds";
  import { relativeTime, STATUS_META } from "../tasks/lib/tasks-api";
  import {
    linkedTableLinks,
    linkRow,
    priorityBars,
    priorityLabel,
    statusTextColor,
  } from "../tasks/task-page/lib/task-page";
  import { prStatusBadge } from "../prs/lib/pr-utils";
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
  const sidebarStore = getSessionSidebarStore();
  const layer = getPopoverLayer();
  let query = $state("");
  let selectedIndex = $state(0);
  let searchEl = $state<HTMLInputElement | null>(null);
  let pickerEl = $state<HTMLDivElement | null>(null);
  let viewportWidth = $state(0);
  let conversationBounds = $state<ConversationBounds | null>(null);
  let wasOpen = false;

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
  const selectedTask = $derived(
    filteredTasks[Math.min(selectedIndex, filteredTasks.length - 1)] ?? null,
  );

  // Works, plans and automations only come from a detail read, so the preview
  // asks for them once the selection settles and shows no Linked section until
  // they arrive. PRs need no read: the sidebar snapshot already carries them.
  const previewDetails = new TaskPreviewDetails((taskId, projectKey) =>
    session.tasksStore.loadDetails(taskId, projectKey),
  );
  const links = $derived(session.tasksStore.detailsFor(selectedTask?.id)?.links ?? []);
  const linkedRows = $derived(linkedTableLinks(links).map(linkRow));
  // PR lifecycle is a provider round trip the picker deliberately does not make:
  // a badge appears when some other surface has already cached that PR, and the
  // row renders without one otherwise rather than inventing a state.
  const prRows = $derived(
    previewPrRows(
      links,
      session.tasksStore.prLinkFor(selectedTask?.id),
      (number) => {
        const cwd = selectedTask?.projectKey;
        const serverId = selectedTask
          ? session.tasksStore.hostFor(selectedTask.id)
          : null;
        if (!cwd || !serverId) return null;
        const detail = session.prsStore.cachedActivity(
          serverId,
          session.ctxForDirectory(cwd),
          number,
        ).detail;
        return detail ? { state: detail.state, draft: detail.draft } : null;
      },
    ),
  );

  $effect(() => {
    if (!open || !selectedTask) return;
    previewDetails.request(selectedTask.id, selectedTask.projectKey ?? undefined);
    return () => previewDetails.cancel();
  });
  const centringStyle = $derived(
    runtime.isMobileViewport
      ? ""
      : centringPadding(conversationBounds, viewportWidth),
  );

  $effect(() => {
    if (!open || inline) return;
    return observeConversationBounds((bounds) => (conversationBounds = bounds));
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
    open = false;
    onClose();
    requestAnimationFrame(() => blurActiveTextInputOnMobile());
  }

  function select(task: Task): void {
    sidebarStore.restoreTask(task.id);
    window.dispatchEvent(
      new CustomEvent("solus:expand-sidebar-task", { detail: task.id }),
    );
    void session.openTaskSession(task);
    close();
  }

  function projectLabel(task: Task): string {
    if (!task.projectKey) return "Inbox";
    return task.projectKey.replace(/\/$/, "").split("/").at(-1) || task.projectKey;
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filteredTasks.length - 1);
    } else if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (event.key === "Enter" && selectedTask) {
      event.preventDefault();
      select(selectedTask);
    }
  }

  useClickOutside(
    () => open && !inline,
    () => [pickerEl],
    close,
  );
</script>

<svelte:window bind:innerWidth={viewportWidth} />

{#snippet pickerContent()}
  <div
    class="relative flex h-12 flex-shrink-0 items-center gap-2.5 px-[1.125rem] after:absolute after:right-[1.125rem] after:bottom-0 after:left-[1.125rem] after:h-px after:bg-[var(--solus-popover-border)] after:opacity-35 after:content-[''] max-md:h-[3.25rem]"
  >
    <MagnifyingGlassIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
    <Input
      bind:ref={searchEl}
      bind:value={query}
      type="text"
      placeholder={`Search ${tasks.length} tasks…`}
      class="h-auto flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
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

  <div class="flex min-h-0 flex-1 overflow-hidden max-md:overflow-visible">
    <div class="w-[clamp(20rem,42%,27.5rem)] shrink-0 overflow-y-auto overscroll-y-contain p-2 max-md:w-full" role="listbox">
      {#if filteredTasks.length === 0}
        <div class="flex h-full items-center justify-center px-5 text-center text-xs text-(--solus-text-tertiary)">
          {session.tasksStore.loading ? "Loading tasks…" : `No tasks match “${query}”`}
        </div>
      {:else}
        {#each filteredTasks as task, index (task.id)}
          <button
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            class="flex h-[46px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left transition-[background-color,color] duration-100 {index === selectedIndex ? 'bg-(--solus-surface-hover) text-(--solus-text-primary)' : 'text-(--solus-text-secondary) hover:bg-(--solus-surface-hover)'}"
            onclick={() => select(task)}
            onpointerenter={() => (selectedIndex = index)}
          >
            <ListChecksIcon size={14} class="shrink-0 text-(--solus-text-tertiary)" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[0.8125rem] font-medium">{task.title}</span>
              <span class="block truncate text-xs text-(--solus-text-tertiary)">{projectLabel(task)}</span>
            </span>
          </button>
        {/each}
      {/if}
    </div>
    <div class="relative min-w-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--solus-surface-primary)_5%,transparent)] p-7 shadow-[inset_0.0625rem_0_0_0_color-mix(in_srgb,var(--solus-popover-border)_45%,transparent)] max-md:hidden">
      {#if selectedTask}
        {@const status = STATUS_META[selectedTask.status]}
        {@const bars = priorityBars(selectedTask.priority)}
        {@const openedAt = selectedTask.createdAt ? relativeTime(selectedTask.createdAt) : ""}
        <div class="mx-auto flex max-w-xl flex-col">
          <div class="flex flex-wrap items-center gap-x-[13px] gap-y-1.5 pb-[11px]">
            <span
              class="inline-flex items-center gap-1.5 text-[0.8125rem]"
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
            <span class="inline-flex items-center gap-1.5 text-[0.8125rem] text-(--solus-text-tertiary)">
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
            <span class="text-[0.8125rem] text-(--solus-text-tertiary)">{projectLabel(selectedTask)}</span>
            {#if openedAt}
              <span class="h-[11px] w-px bg-[var(--hairline-strong)]" aria-hidden="true"></span>
              <span class="font-mono text-xs text-(--solus-text-tertiary) opacity-75">opened {openedAt}</span>
            {/if}
          </div>
          <h2 class="m-0 text-[1.5rem] font-medium leading-[1.25] text-pretty text-(--solus-text-primary)">{selectedTask.title}</h2>
          {#if selectedTask.body}
            <p class="whitespace-pre-wrap text-pretty pt-[18px] text-[0.8125rem] leading-6 text-(--solus-text-secondary)">{selectedTask.body}</p>
          {:else}
            <p class="pt-[18px] text-[0.8125rem] text-(--solus-text-tertiary)">No task description.</p>
          {/if}
          {#if prRows.length}
            <div class="flex flex-col gap-[7px] pt-[26px]">
              <div class="flex items-center gap-2.5">
                <span class="text-xs font-normal uppercase text-(--solus-text-tertiary)">Pull requests</span>
                <span class="font-mono text-xs tabular-nums text-(--solus-text-tertiary) opacity-70">{prRows.length}</span>
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
                    <span class="flex h-5 shrink-0 items-center font-mono text-xs tabular-nums text-(--solus-text-tertiary) opacity-65">{row.ref}</span>
                    <span class="flex h-5 min-w-0 flex-1 items-center truncate text-[0.8125rem]">
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
                <span class="font-mono text-xs tabular-nums text-(--solus-text-tertiary) opacity-70">{linkedRows.length}</span>
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
                    <span class="min-w-0 flex-1 truncate text-[0.8125rem]">{row.label}</span>
                    <span class="w-[92px] shrink-0 text-xs whitespace-nowrap text-(--solus-text-tertiary) opacity-70">{row.kindLabel}</span>
                    <span class="w-[88px] shrink-0 truncate text-right text-xs whitespace-nowrap text-(--solus-text-tertiary) opacity-75">{row.meta}</span>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <button
            type="button"
            class="mt-6 self-start rounded-lg bg-(--solus-accent-light) px-3 py-1.5 text-xs font-medium text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-(--solus-accent-soft) active:scale-[0.96]"
            onclick={() => select(selectedTask)}
          >Open new draft</button>
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

{#if open && inline}
  <div bind:this={pickerEl} class="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-transparent outline-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown} transition:fly={{ y: 8, duration: 160 }}>
    {@render pickerContent()}
  </div>
{:else if open && layer.el}
  <div use:portal={layer.el} class="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center overflow-hidden overscroll-contain bg-[color-mix(in_srgb,var(--solus-modal-scrim)_55%,transparent)] motion-safe:animate-[backdrop-fade_140ms_ease-out]" style={centringStyle}>
    <div bind:this={pickerEl} class="flex h-3/4 max-h-[75%] w-3/4 origin-top flex-col overflow-hidden overscroll-contain rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] outline-none animate-[picker-enter_180ms_cubic-bezier(0.22,1,0.36,1)_both] max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:rounded-none max-md:border-none max-md:bg-(--solus-container-bg) max-md:shadow-none" role="dialog" aria-label="Task picker" tabindex="-1" onkeydown={handleKeyDown}>
      {@render pickerContent()}
    </div>
  </div>
{/if}
