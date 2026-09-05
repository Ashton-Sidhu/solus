<script lang="ts">
  import { ExternalLink as ExternalLinkIcon } from "@lucide/svelte";
  import type { Task, TaskLink } from "@solus/contracts/task-types";
  import { getPullRequestsContext, getWorkspaceContext } from "../../../contexts";
  import type { SidebarSessionChild } from "../../../contexts/workspace/session-sidebar.store.svelte";
  import { relativeTime, STATUS_META } from "../../tasks/lib/tasks-api";
  import TaskStatusGlyph from "../../tasks/TaskStatusGlyph.svelte";
  import {
    linkedTableLinks,
    linkRow,
    priorityBars,
    priorityLabel,
  } from "../../tasks/task-page/lib/task-page";
  import { prStatusBadge } from "../../prs/lib/pr-utils";
  import { prLifecycleOf } from "../../tasks/task-page/lib/task-prs";
  import {
    previewPrGlyph,
    previewPrRows,
    TaskPreviewDetails,
  } from "../lib/task-preview.svelte";
  import SessionStatusGlyph from "../SessionStatusGlyph.svelte";
  import { highlightRuns, type TextRun } from "../../../lib/searchHighlight";
  import { projectLabel } from "./lib/picker-rows";

  /**
   * The selected task in miniature. Task-level commands live in the pinned
   * action bar; each linked row keeps its own open and unlink commands beside
   * the item, matching the task page table on desktop and phone.
   */
  interface Props {
    task: Task;
    /** The task's sessions, the same list the sidebar draws under it. */
    sessions: SidebarSessionChild[];
    onSelectSession: (session: SidebarSessionChild) => void;
    onOpenLink: (link: TaskLink) => void;
    onOpenExternal: (url: string) => void;
    onUnlink: (link: TaskLink) => void;
    /** The picker's live search term. A row only shows a passage of a body
     *  hit; the preview is where the whole body is, so it marks the hit too. */
    query?: string;
  }
  let {
    task,
    sessions,
    onSelectSession,
    onOpenLink,
    onOpenExternal,
    onUnlink,
    query = "",
  }: Props = $props();

  const session = getWorkspaceContext();
  const pullRequests = getPullRequestsContext();

  const status = $derived(STATUS_META[task.status]);
  const bars = $derived(priorityBars(task.priority));
  const openedAt = $derived(task.createdAt ? relativeTime(task.createdAt) : "");

  // Works, plans and automations only come from a detail read, so the preview
  // asks for them once the selection settles and shows no Linked section until
  // they arrive. PRs need no read: the sidebar snapshot already carries them.
  const previewDetails = new TaskPreviewDetails((taskId, projectKey) =>
    session.tasksStore.get(taskId, projectKey).loadDetails(),
  );
  const details = $derived(session.tasksStore.get(task.id).details);
  const links = $derived(details?.links ?? []);
  const linkedRows = $derived(linkedTableLinks(links).map((link) => linkRow(link)));
  // A PR's state and title are a provider round trip the picker deliberately
  // does not make: both appear when some other surface has already read that
  // PR, and the row renders from its link snapshot otherwise.
  const prScope = $derived({
    cwd: task.projectKey ?? null,
    serverId: session.tasksStore.get(task.id).serverId,
  });
  const prRows = $derived(
    previewPrRows(
      links,
      session.tasksStore.get(task.id).prLink,
      (number) =>
        prLifecycleOf(
          pullRequests.projects.at(prScope.serverId, prScope.cwd)?.prFor(number) ?? null,
        ),
      (number) =>
        pullRequests.projects.at(prScope.serverId, prScope.cwd)?.prFor(number)?.title ||
        undefined,
    ),
  );
  const linkedCount = $derived(linkedRows.length + prRows.length);

  $effect(() => {
    previewDetails.request(task.id, task.projectKey ?? undefined);
    return () => previewDetails.cancel();
  });
</script>

{#snippet marked(runs: TextRun[])}
  {#each runs as run, i (i)}{#if run.hit}<mark
        class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
        >{run.text}</mark
      >{:else}{run.text}{/if}{/each}
{/snippet}

{#snippet sectionHeading(label: string, count: number)}
  <div class="mb-1.5 flex items-center gap-2.5 max-md:mb-0">
    <span class="text-micro font-medium tracking-[0.13em] uppercase text-muted-foreground">{label}</span>
    <span class="h-px flex-1 bg-[var(--hairline)] max-md:hidden" aria-hidden="true"></span>
    <span class="font-mono text-micro tabular-nums text-muted-foreground opacity-50 max-md:tracking-[0.13em] max-md:opacity-100">
      <span class="hidden max-md:inline">·</span> {count}
    </span>
  </div>
{/snippet}

<div class="flex min-w-0 flex-col">
  <!-- On a phone the sheet's header already says which task this is about, so
       the meta line yields to the title. -->
  <div class="mb-3 flex flex-wrap items-center gap-2.5 text-micro text-muted-foreground max-md:hidden">
    <span class="inline-flex items-center gap-1.5">
      <TaskStatusGlyph status={task.status} size={12} />
      {status.label}
    </span>
    <span class="opacity-[0.32]" aria-hidden="true">/</span>
    <span class="inline-flex items-center gap-1.5">
      <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
        {#each bars as bar (bar.height)}
          <span class="w-[2.5px] rounded-[0.0625rem]" style="height:{bar.height};background:{bar.background}"></span>
        {/each}
      </span>
      {priorityLabel(task.priority)}
    </span>
    <span class="opacity-[0.32]" aria-hidden="true">/</span>
    <span>{projectLabel(task)}</span>
    {#if openedAt}
      <span class="opacity-[0.32]" aria-hidden="true">/</span>
      <span>opened {openedAt}</span>
    {/if}
  </div>
  <h3 class="mb-2.5 text-[1.1875rem] leading-[1.3] font-semibold tracking-[-0.014em] text-pretty text-foreground max-md:mb-2">{@render marked(highlightRuns(task.title, query))}</h3>
  {#if task.body}
    <p class="mb-5 whitespace-pre-wrap text-workspace-chrome leading-[1.7] text-pretty text-muted-foreground max-md:mb-[18px]">{@render marked(highlightRuns(task.body, query))}</p>
  {:else}
    <p class="mb-5 text-workspace-chrome leading-[1.7] text-muted-foreground opacity-70 max-md:mb-[18px]">No task description.</p>
  {/if}

  <!-- The task's sessions as a compact roll, so a reader who came for one of
       them can jump straight past the preview instead of going back to the
       list to expand the row they just left. -->
  {#if sessions.length}
    <div class="mb-5 flex flex-col max-md:rounded-xl max-md:bg-card max-md:px-3.5 max-md:pt-[13px] max-md:pb-1 max-md:shadow-[shadow:var(--elev-ring)]">
      {@render sectionHeading("Sessions", sessions.length)}
      <!-- A long-lived task can hold dozens of sessions. The roll is a jump
           list, not the page, so it stops at five rows and scrolls. -->
      <div class="flex max-h-[150px] flex-col overflow-y-auto max-md:max-h-[190px]">
      {#each sessions as item, index (item.sessionId ?? item.tabId ?? index)}
        <button
          type="button"
          class="flex h-[30px] w-full shrink-0 cursor-pointer items-center gap-3 overflow-hidden text-left text-workspace-chrome transition-[background-color] duration-100 hover:bg-[var(--wash-1)] max-md:h-[38px] {index ? 'border-t-[0.5px] border-[var(--hairline)]' : ''} {index === 0 ? 'text-foreground' : 'text-muted-foreground'}"
          onclick={() => onSelectSession(item)}
        >
          <SessionStatusGlyph attention={item.attention} />
          <span class="min-w-0 flex-1 truncate">{item.label}</span>
          <span class="shrink-0 font-mono text-micro whitespace-nowrap tabular-nums opacity-60">{relativeTime(item.lastActivityAt || task.updatedAt)}</span>
        </button>
      {/each}
      </div>
    </div>
  {/if}

  {#if details || prRows.length}
    <div class="mb-5 flex flex-col gap-[7px] text-micro">
      <div class="flex items-center gap-2">
        <span class="font-medium tracking-[0.13em] uppercase text-muted-foreground">Linked</span>
        <span class="tabular-nums text-muted-foreground opacity-70">{linkedCount}</span>
        <span class="h-px flex-1 bg-[var(--hairline)]" aria-hidden="true"></span>
      </div>
      <div class="flex flex-col">
        {#if linkedCount}
          <div class="flex h-6 items-center gap-[11px] border-b-[0.5px] border-[var(--hairline)] px-1 text-muted-foreground uppercase opacity-75" aria-hidden="true">
            <span class="w-3.5 shrink-0"></span>
            <span class="min-w-0 flex-1">Item</span>
            <span class="w-[92px] shrink-0">Kind</span>
            <span class="w-[88px] shrink-0 text-right">Status</span>
          </div>
          {#each prRows as row (row.key)}
            {@const badge = prStatusBadge(row.state)}
            {@const glyph = previewPrGlyph(row.state)}
            {@const PrIcon = glyph.Icon}
            <div
              class="group flex h-[33px] cursor-pointer items-center gap-[11px] border-b-[0.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] px-1 text-workspace-chrome transition-colors hover:bg-[var(--wash-1)]"
              role="button"
              tabindex="0"
              onclick={() => {
                if (row.link) onOpenLink(row.link);
                else if (row.url) onOpenExternal(row.url);
              }}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (row.link) onOpenLink(row.link);
                  else if (row.url) onOpenExternal(row.url);
                }
              }}
            >
              <span class="flex size-3.5 shrink-0 items-center justify-center" style="color:{glyph.tone}" aria-hidden="true">
                <PrIcon size={13} />
              </span>
              <span class="flex min-w-0 flex-1 items-center gap-2">
                <span class="shrink-0 tabular-nums text-muted-foreground opacity-60">{row.ref}</span>
                {#if row.title}
                  <span class="min-w-0 truncate">{row.title}</span>
                {:else}
                  <span class="h-[9px] w-24 rounded-full bg-[var(--wash-2)]" aria-hidden="true"></span>
                {/if}
              </span>
              <span class="w-[92px] shrink-0 text-muted-foreground opacity-70">PR</span>
              <span class="flex w-[88px] shrink-0 items-center justify-end gap-1 text-muted-foreground">
                <span class="min-w-0 flex-1 truncate text-right opacity-75" style:color={badge?.tone}>
                  {badge?.label ?? ""}
                </span>
                {#if row.url}
                  {@const url = row.url}
                  <button
                    type="button"
                    class="flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground"
                    onclick={(event) => {
                      event.stopPropagation();
                      onOpenExternal(url);
                    }}
                    title="Open {row.ref} in the browser"
                    aria-label="Open {row.ref} in the browser"
                  >
                    <ExternalLinkIcon size={10} />
                  </button>
                {/if}
                {#if row.link}
                  {@const link = row.link}
                  <button
                    type="button"
                    class="flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground"
                    onclick={(event) => {
                      event.stopPropagation();
                      onUnlink(link);
                    }}
                    title="Unlink {row.ref}"
                    aria-label="Unlink {row.ref}"
                  >
                    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg>
                  </button>
                {/if}
              </span>
            </div>
          {/each}
          {#each linkedRows as row (row.key)}
            <div
              class="group flex h-[33px] cursor-pointer items-center gap-[11px] border-b-[0.5px] border-[color-mix(in_oklch,var(--hairline)_60%,transparent)] px-1 text-workspace-chrome transition-colors hover:bg-[var(--wash-1)]"
              role="button"
              tabindex="0"
              onclick={() => onOpenLink(row.link)}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onOpenLink(row.link);
                }
              }}
            >
              <span class="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground opacity-50">
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
              <span class="w-[92px] shrink-0 truncate text-muted-foreground opacity-70">{row.kindLabel}</span>
              <span class="flex w-[88px] shrink-0 items-center justify-end gap-1 text-muted-foreground">
                <span class="min-w-0 flex-1 truncate text-right opacity-75">{row.meta}</span>
                <button
                  type="button"
                  class="flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-[var(--wash-2)] hover:text-foreground"
                  onclick={(event) => {
                    event.stopPropagation();
                    onUnlink(row.link);
                  }}
                  title="Unlink {row.label}"
                  aria-label="Unlink {row.label}"
                >
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" /></svg>
                </button>
              </span>
            </div>
          {/each}
        {:else}
          <div class="px-1 py-3.5 text-workspace-chrome text-muted-foreground">
            Nothing linked yet.
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
