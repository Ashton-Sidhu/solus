<script lang="ts">
  import type {
    Task,
    TaskPriority,
    TaskStatus,
    TaskUpdatePatch,
  } from "@solus/contracts/task-types";
  import { group, row, rowLabel, valueButton } from "./lib/sidebar-styles";
  import { RefreshCw as ArrowsClockwiseIcon, LoaderCircle as CircleNotchIcon, Folder as FolderIcon } from "@lucide/svelte";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import ProjectFavicon from "../../ui/ProjectFavicon.svelte";
  import { SourceLogo } from "../../ui/list-page";
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
    /** Which of the sidebar's two homes this is. The sheet is portalled to the
     *  body, so it cannot be told apart by a container query. */
    variant?: "column" | "sheet";
    projectLabel: string;
    projectRoot?: string;
    serverId?: string | null;
    canEdit: boolean;
    canEditPlanningFields: boolean;
    canEditPriority: boolean;
    canEditLabels: boolean;
    editableStatuses: TaskStatus[];
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
    variant = "column",
    projectLabel,
    projectRoot,
    serverId,
    canEdit,
    canEditPlanningFields,
    canEditPriority,
    canEditLabels,
    editableStatuses,
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

  const PRIORITY_OPTIONS: TaskPriority[] = ["urgent", "high", "medium", "low"];

  const sheet = $derived(variant === "sheet");
  const GROUP = $derived(group(sheet));
  const ROW = $derived(row(sheet));
  const ROW_LABEL = $derived(rowLabel(sheet));
  const VALUE_BUTTON = $derived(valueButton(sheet));
  // The static twin of VALUE_BUTTON. In the column it takes the row's remaining
  // width; in the sheet the label already has it, so the value sizes to itself.
  const VALUE = $derived(
    sheet
      ? "flex h-[34px] items-center gap-2 font-medium"
      : "flex h-[34px] flex-1 items-center gap-2 px-2",
  );

  const status = $derived(STATUS_META[task.status]);
  const bars = $derived(priorityBars(task.priority));

  let labelDraft = $state("");

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


<div
  class={sheet
    ? "flex w-full flex-col gap-3.5"
    : "sticky top-0 flex w-[var(--task-rail-width)] [--task-rail-width:308px] shrink-0 flex-col rounded-2xl bg-card shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_11%,transparent),0_1px_2px_-1px_rgba(0,0,0,.05),0_12px_28px_-12px_rgba(0,0,0,.14)] [.is-laptop-display_&]:[--task-rail-width:260px]"}
>
  <div class={GROUP}>
    <div class={ROW}>
      <span class={ROW_LABEL}>Status</span>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger disabled={!editableStatuses.length} class={VALUE_BUTTON}>
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
          {#each editableStatuses as option (option)}
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
        <DropdownMenu.Trigger disabled={!canEditPriority} class={VALUE_BUTTON}>
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
        <span class={VALUE}>
          <span
            class="flex size-[18px] shrink-0 items-center justify-center rounded-full  font-medium shadow-[inset_0_0_0_.5px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
            style="background:color-mix(in oklch, var(--chart-1) 22%, transparent);color:color-mix(in oklch, var(--chart-1) 72%, var(--foreground))"
          >
            {authorInitials(task.assignee)}
          </span>
          {task.assignee}
        </span>
      {:else}
        <span class="{VALUE} text-muted-foreground">
          Unassigned
        </span>
      {/if}
    </div>

    <div class={ROW}>
      <span class={ROW_LABEL}>Project</span>
      <span class="{VALUE} min-w-0">
        {#if projectRoot}
          <ProjectFavicon {serverId} projectRoot={projectRoot} class="size-3" />
        {:else}
          <FolderIcon size={12} class="shrink-0 text-(--solus-text-tertiary)" />
        {/if}
        <span class="truncate">{projectLabel}</span>
      </span>
    </div>

    <div
      class="flex min-h-[34px] items-start {sheet
        ? 'min-h-[54px] gap-[11px] px-3.5 py-2.5'
        : ''}"
    >
      <span class="{ROW_LABEL} leading-[34px] {sheet ? 'flex-none' : ''}"
        >Labels</span
      >
      <span
        class="flex min-w-0 flex-1 flex-wrap items-center gap-1 pt-1 {sheet
          ? 'justify-end'
          : 'pl-2'}"
      >
        {#each task.labels as label (label)}
          <span
            class="inline-flex h-[19px] items-center gap-1 rounded-full px-1.5  font-normal text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)]"
          >
            {label}
            {#if canEditLabels}
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
        {#if canEditLabels}
          <input
            data-dictation="false"
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
          class="h-[34px] cursor-pointer rounded-md bg-transparent text-muted-foreground outline-none hover:bg-[var(--wash-2)] hover:text-foreground {sheet
            ? 'text-right font-medium text-foreground'
            : 'flex-1 px-2'}"
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

  {#if upstream}
    {@const tone = syncToneColor(upstream.tone)}
    <div
      class={sheet
        ? "flex flex-col gap-[7px]"
        : "flex flex-col gap-[11px] border-t-[.5px] border-[var(--hairline)] px-3.5 pt-[15px] pb-4"}
    >
      <span
        class="font-normal text-muted-foreground uppercase {sheet
          ? 'pl-1'
          : 'pl-0.5'}">Upstream</span
      >
      <div class={sheet ? GROUP : "flex flex-col gap-1"}>
        <div class={ROW}>
          <span class={ROW_LABEL}>Provider</span>
          {#if upstream.url}
            {@const url = upstream.url}
            <button
              type="button"
              class="{VALUE_BUTTON} min-w-0 overflow-hidden"
              onclick={() => onOpenUpstream(url)}
              title="Open {upstream.provider} {upstream.ref} in the browser"
            >
              <SourceLogo source={upstream.providerId} />
              <span class="truncate">{upstream.provider}</span>
              <span class="flex-1"></span>
              <span class="shrink-0  text-muted-foreground opacity-80">
                {upstream.ref}
              </span>
            </button>
          {:else}
            <span class="{VALUE} min-w-0">
              <SourceLogo source={upstream.providerId} />
              <span class="truncate">{upstream.provider}</span>
            </span>
          {/if}
        </div>

        <div class={ROW}>
          <span class={ROW_LABEL}>State</span>
          <span
            class="{VALUE} min-w-0"
            title={upstream.title}
          >
            <span class="size-[6px] shrink-0 rounded-full" style="background:{tone}"></span>
            <span class="truncate" style="color:{tone}">{upstream.label}</span>
          </span>
        </div>

        {#if upstream.canSync && autoPost !== null}
          <div class={ROW}>
            <span class={ROW_LABEL}>Auto-post</span>
            <span class="{VALUE} min-w-0">
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
            <span class="{VALUE} min-w-0">
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
    <div
      class={sheet
        ? "flex flex-col gap-[7px]"
        : "flex flex-col gap-[11px] border-t-[.5px] border-[var(--hairline)] px-3.5 pt-[15px] pb-4"}
    >
      <span
        class="font-normal text-muted-foreground uppercase {sheet
          ? 'pl-1'
          : 'pl-0.5'}">Upstream</span
      >
      <div class={sheet ? GROUP : "flex flex-col gap-1"}>
        <div class={ROW}>
          <span class={ROW_LABEL}>Provider</span>
          <!-- Only the provider: the repository is the project this page is
               already in, so naming it here spends the row's width on something
               the user knows. It rides the Publish button's title instead. -->
          <span
            class="{VALUE} min-w-0"
            title={publishTarget.scope ?? undefined}
          >
            <SourceLogo source={publishTarget.providerId} />
            <span class="truncate">{publishTarget.provider}</span>
          </span>
        </div>
        <div class={ROW}>
          <span class={ROW_LABEL}>State</span>
          <span class="{VALUE} min-w-0">
            <span class="truncate text-muted-foreground">Solus only</span>
            <span class="flex-1"></span>
            <button
              type="button"
              class="flex h-[22px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2  font-medium text-muted-foreground shadow-[0_0_0_.5px_color-mix(in_oklch,var(--foreground)_13%,transparent)] transition-colors hover:text-primary hover:shadow-[0_0_0_.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] disabled:pointer-events-none disabled:opacity-45"
              onclick={onPublishTask}
              disabled={syncing}
              title="Create an issue in {publishTarget.scope ??
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
    class={sheet
      ? "flex items-center gap-2 px-1 pt-0.5 font-mono text-xs"
      : "flex items-center gap-2 border-t-[.5px] border-[var(--hairline)] px-4 pt-[13px] pb-3.5"}
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
