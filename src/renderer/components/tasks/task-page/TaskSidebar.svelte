<script lang="ts">
  import type {
    Task,
    TaskPriority,
    TaskStatus,
    TaskUpdatePatch,
  } from "../../../../shared/task-types";
  import { ArrowsClockwiseIcon, CircleNotchIcon } from "phosphor-svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import CopyButton from "../../ui/CopyButton.svelte";
  import ProjectFavicon from "../../ui/ProjectFavicon.svelte";
  import { authorInitials, PRIORITY_META, relativeTime, STATUS_META } from "../lib/tasks-api";
  import { priorityBars, priorityLabel, statusTextColor } from "./lib/task-page";
  import {
    syncToneColor,
    type TaskPublishTarget,
    type TaskUpstreamState,
  } from "./lib/task-upstream";
  import { Switch } from "../../ui/switch";

  interface Props {
    task: Task;
    projectLabel: string;
    projectRoot?: string;
    canEdit: boolean;
    canEditPlanningFields: boolean;
    /** Null for a task with no upstream: the whole group is then absent, rather
     *  than present and empty. */
    upstream: TaskUpstreamState | null;
    /** Where this task could be filed when it has no ticket yet. Null when the
     *  project has no provider, or when it already has one. */
    publishTarget: TaskPublishTarget | null;
    syncing: boolean;
    /** The project posts every comment upstream. Null when the setting cannot
     *  be read or written from here, which hides the toggle. */
    autoPost: boolean | null;
    onSyncNow: () => void;
    onSetAutoPost: (next: boolean) => void;
    onPublishAll: () => void;
    onPublishTask: () => void;
    onOpenUpstream: (url: string) => void;
    onSave: (patch: TaskUpdatePatch) => void;
  }

  let {
    task,
    projectLabel,
    projectRoot,
    canEdit,
    canEditPlanningFields,
    upstream,
    publishTarget,
    syncing,
    autoPost,
    onSyncNow,
    onSetAutoPost,
    onPublishAll,
    onPublishTask,
    onOpenUpstream,
    onSave,
  }: Props = $props();

  const STATUS_OPTIONS: TaskStatus[] = [
    "inbox",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "dropped",
  ];
  const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "medium", "low"];

  const status = $derived(STATUS_META[task.status]);
  const bars = $derived(priorityBars(task.priority));
  const branches = $derived(task.branch ? [task.branch] : []);

  let labelDraft = $state("");

  const ROW = "flex h-[34px] items-center";
  const ROW_LABEL = "w-[78px] shrink-0 pl-0.5 text-xs text-muted-foreground";
  const VALUE_BTN =
    "flex h-[34px] flex-1 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-[var(--wash-2)]";
  const GROUP = "flex flex-col gap-1 px-3.5 pt-[15px] pb-4";

  function addLabel() {
    const next = labelDraft
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !task.labels.includes(l));
    labelDraft = "";
    if (next.length) onSave({ labels: [...task.labels, ...next] });
  }

  function removeLabel(label: string) {
    onSave({ labels: task.labels.filter((l) => l !== label) });
  }
</script>

{#snippet providerMark(glyph: string)}
  <svg
    width="12"
    height="12"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="text-xs shrink-0 opacity-60"
    aria-hidden="true"><path d={glyph} /></svg
  >
{/snippet}

<div
  class="sticky top-0 flex w-[var(--task-rail-width)] [--task-rail-width:308px] shrink-0 flex-col rounded-2xl bg-card text-workspace-chrome shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent),0_1px_2px_-1px_rgba(0,0,0,.05),0_12px_28px_-12px_rgba(0,0,0,.14)] [.is-laptop-display_&]:[--task-rail-width:260px] @max-[60rem]:static @max-[60rem]:w-full"
>
  <div class={GROUP}>
    <div class={ROW}>
      <span class={ROW_LABEL}>Status</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={!canEdit} class={VALUE_BTN}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.45"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="shrink-0"
            style="color:{statusTextColor(task.status)}"
            aria-hidden="true"><path d={status.glyph} /></svg
          >
          {status.label}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-[182px]">
          {#each STATUS_OPTIONS as option (option)}
            {@const meta = STATUS_META[option]}
            <DropdownMenu.Item onSelect={() => onSave({ status: option })}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                stroke-width="1.45"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="shrink-0"
                style="color:{statusTextColor(option)}"
                aria-hidden="true"><path d={meta.glyph} /></svg
              >
              {meta.label}
              {#if option === task.status}
                <span class="ml-auto text-primary" aria-hidden="true">✓</span>
              {/if}
            </DropdownMenu.Item>
          {/each}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Priority</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={!canEditPlanningFields} class={VALUE_BTN}>
          <span class="flex h-[9px] shrink-0 items-end gap-[1.5px]" aria-hidden="true">
            {#each bars as bar (bar.height)}
              <span
                class="w-[2.5px] rounded-[0.0625rem]"
                style="height:{bar.height};background:{bar.background}"
              ></span>
            {/each}
          </span>
          {priorityLabel(task.priority)}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-[182px]">
          {#each PRIORITY_OPTIONS as option (option)}
            <DropdownMenu.Item onSelect={() => onSave({ priority: option })}>
              {PRIORITY_META[option].label}
              {#if option === task.priority}
                <span class="ml-auto text-primary" aria-hidden="true">✓</span>
              {/if}
            </DropdownMenu.Item>
          {/each}
          <DropdownMenu.Item onSelect={() => onSave({ priority: null })}>
            No priority
            {#if !task.priority}
              <span class="ml-auto text-primary" aria-hidden="true">✓</span>
            {/if}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Assignee</span>
      {#if task.assignee}
        <span class="flex h-[34px] flex-1 items-center gap-2 px-2">
          <span
            class="flex size-[18px] shrink-0 items-center justify-center rounded-full  font-medium shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
            style="background:color-mix(in oklch, var(--chart-1) 22%, transparent);color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"
          >
            {authorInitials(task.assignee)}
          </span>
          {task.assignee}
        </span>
      {:else}
        <span class="flex h-[34px] flex-1 items-center px-2 text-muted-foreground">
          Unassigned
        </span>
      {/if}
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Project</span>
      <span class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2">
        {#if projectRoot}
          <ProjectFavicon
            projectRoot={projectRoot}
            class="size-3"
            coloredFallback
          />
        {:else}
          <span class="size-3 shrink-0 rounded-[0.1875rem] bg-(--chart-4)" aria-hidden="true"></span>
        {/if}
        <span class="truncate">{projectLabel}</span>
      </span>
    </div>

    <div class="flex min-h-[34px] items-start">
      <span class="{ROW_LABEL} leading-[34px]">Labels</span>
      <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1 pt-1 pl-2">
        {#each task.labels as label (label)}
          <span
            class="inline-flex h-[19px] items-center gap-1 rounded-full px-1.5  font-normal text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]"
          >
            {label}
            {#if canEdit}
              <button
                type="button"
                class="cursor-pointer opacity-60 hover:opacity-100"
                onclick={() => removeLabel(label)}
                aria-label="Remove label {label}"
              >
                ×
              </button>
            {/if}
          </span>
        {/each}
        {#if canEdit}
          <input
            class="h-[19px] min-w-[60px] flex-1 bg-transparent  text-muted-foreground outline-none placeholder:text-muted-foreground/70"
            bind:value={labelDraft}
            placeholder="Add a label…"
            onblur={addLabel}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLabel();
              }
            }}
          />
        {/if}
      </span>
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Target</span>
      {#if canEditPlanningFields}
        <input
          type="date"
          class="h-[34px] flex-1 cursor-pointer rounded-md bg-transparent px-2  text-muted-foreground outline-none hover:bg-[var(--wash-2)] hover:text-foreground"
          value={task.dueDate ?? ""}
          onchange={(e) => onSave({ dueDate: e.currentTarget.value || null })}
          aria-label="Target date"
        />
      {:else}
        <span class="flex h-[34px] flex-1 items-center px-2  text-muted-foreground">
          {task.dueDate ?? "None"}
        </span>
      {/if}
    </div>
  </div>

  {#if branches.length}
    <div class="{GROUP} gap-[11px] border-t-[.5px] border-[var(--hairline)]">
      <span
        class="pl-0.5  font-normal text-muted-foreground uppercase"
      >
        Work
      </span>
      <div class="flex items-start">
        <span class="{ROW_LABEL} leading-[34px]">
          {branches.length > 1 ? "Branches" : "Branch"}
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-px py-[3px]">
          <!-- A branch name is long, and the one thing a user wants from it is
               the whole string somewhere they can paste. Hover shows it in full
               and hands over a copy button; the row itself stays one line. -->
          {#each branches as branch (branch)}
            <span
              class="group/branch flex h-7 items-center gap-1 rounded-md pr-1 pl-2 font-mono  text-muted-foreground hover:bg-[var(--wash-2)]"
              title={branch}
            >
              <span class="min-w-0 flex-1 truncate">{branch}</span>
              <span
                class="shrink-0 opacity-0 transition-opacity group-hover/branch:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
              >
                <CopyButton text={branch} title="Copy branch name" iconOnly />
              </span>
            </span>
          {/each}
        </span>
      </div>
    </div>
  {/if}

  {#if upstream}
    {@const tone = syncToneColor(upstream.tone)}
    <div class="{GROUP} gap-[11px] border-t-[.5px] border-[var(--hairline)]">
      <span class="pl-0.5  font-normal text-muted-foreground uppercase">Upstream</span>
      <div class="flex flex-col gap-1">
        <div class={ROW}>
          <span class={ROW_LABEL}>Provider</span>
          {#if upstream.url}
            {@const url = upstream.url}
            <button
              type="button"
              class="{VALUE_BTN} min-w-0"
              onclick={() => onOpenUpstream(url)}
              title="Open {upstream.provider} {upstream.ref} in the browser"
            >
              {@render providerMark(upstream.glyph)}
              <span class="truncate">{upstream.provider}</span>
              <span class="flex-1"></span>
              <span class="shrink-0  text-muted-foreground opacity-80">
                {upstream.ref}
              </span>
            </button>
          {:else}
            <span class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2">
              {@render providerMark(upstream.glyph)}
              <span class="truncate">{upstream.provider}</span>
            </span>
          {/if}
        </div>

        <div class={ROW}>
          <span class={ROW_LABEL}>State</span>
          <span
            class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2"
            title={upstream.title}
          >
            <span class="size-[6px] shrink-0 rounded-full" style="background:{tone}"></span>
            <span class="truncate" style="color:{tone}">{upstream.label}</span>
          </span>
        </div>

        {#if upstream.canSync && autoPost !== null}
          <div class={ROW}>
            <span class={ROW_LABEL}>Auto-post</span>
            <span class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2">
              <Switch
                size="sm"
                checked={autoPost}
                onCheckedChange={onSetAutoPost}
                aria-label="Post every comment to {upstream.provider}"
              />
              <span class="truncate {autoPost ? '' : 'text-muted-foreground'}">
                {autoPost ? "Every comment" : "Off"}
              </span>
            </span>
          </div>
        {/if}

        {#if upstream.canSync}
          <div class={ROW}>
            <span class={ROW_LABEL}>Pending</span>
            <span class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2">
              <span
                class="truncate {upstream.pendingCount ? '' : 'text-muted-foreground'}"
                title={upstream.title}
              >
                {upstream.pendingLabel}
              </span>
              <span class="flex-1"></span>
              {#if upstream.heldBackCount}
                <button
                  type="button"
                  class="flex h-[22px] shrink-0 cursor-pointer items-center rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)]"
                  onclick={onPublishAll}
                  title="Publish {upstream.heldBackCount} held-back comment{upstream.heldBackCount ===
                  1
                    ? ''
                    : 's'} to {upstream.provider}"
                >
                  Publish all
                </button>
              {/if}
              <!-- The engine pushes on its own debounce; this is the user saying
                   don't wait — after repairing auth, or before trusting the page. -->
              <button
                type="button"
                class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] disabled:pointer-events-none disabled:opacity-45"
                onclick={onSyncNow}
                disabled={syncing}
              >
                {#if syncing}
                  <CircleNotchIcon
                    size={11}
                    class="animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                  Syncing
                {:else}
                  <ArrowsClockwiseIcon size={11} aria-hidden="true" />
                  Sync now
                {/if}
              </button>
            </span>
          </div>
        {/if}
      </div>
    </div>

  {/if}

  {#if publishTarget}
    <!-- A local task in a project that files tickets: the page says where it
         would go and offers to put it there, rather than leaving the provider
         reachable only from the Tasks list. -->
    <div class="{GROUP} gap-[11px] border-t-[.5px] border-[var(--hairline)]">
      <span class="pl-0.5  font-normal text-muted-foreground uppercase">Upstream</span>
      <div class="flex flex-col gap-1">
        <div class={ROW}>
          <span class={ROW_LABEL}>Provider</span>
          <!-- Only the provider: the repository is the project this page is
               already in, so naming it here spends the row's width on something
               the user knows. It rides the Publish button's title instead. -->
          <span
            class="flex h-[34px] min-w-0 flex-1 items-center px-2"
            title={publishTarget.repo ?? undefined}
          >
            <span class="truncate">{publishTarget.provider}</span>
          </span>
        </div>
        <div class={ROW}>
          <span class={ROW_LABEL}>State</span>
          <span class="flex h-[34px] min-w-0 flex-1 items-center gap-2 px-2">
            <span class="truncate text-muted-foreground">Solus only</span>
            <span class="flex-1"></span>
            <button
              type="button"
              class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] disabled:pointer-events-none disabled:opacity-45"
              onclick={onPublishTask}
              disabled={syncing}
              title="Create an issue in {publishTarget.repo ??
                publishTarget.provider} for this task and keep the two in sync"
            >
              {#if syncing}
                <CircleNotchIcon
                  size={11}
                  class="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                Publishing
              {:else}
                Publish
              {/if}
            </button>
          </span>
        </div>
      </div>
    </div>
  {/if}

  <div
    class="flex items-center gap-2 border-t-[.5px] border-[var(--hairline)] px-4 pt-[13px] pb-3.5"
  >
    <span class="text-muted-foreground opacity-80">Created</span>
    <span class="text-muted-foreground opacity-65">
      {task.createdAt ? relativeTime(task.createdAt) : "—"}
    </span>
    <span class="flex-1"></span>
    <span class="text-muted-foreground opacity-80">Updated</span>
    <span class="text-muted-foreground opacity-65">
      {relativeTime(task.updatedAt)}
    </span>
  </div>
</div>
