<script lang="ts">
  import TaskIcon from "../ui/TaskIcon.svelte";
  import {
    ExternalLink as ArrowSquareOutIcon,
    ChartBar as ChartBarIcon,
    MessageCircleMore as ChatCircleDotsIcon,
    Check as CheckIcon,
    Copy as CopyIcon,
    GitPullRequest as GitPullRequestIcon,
    ListChecks as ListChecksIcon,
    Moon as MoonIcon,
    Play as PlayIcon,
    Pen as PencilSimpleIcon,
    Sun as SunIcon,
    CircleStop as StopCircleIcon,
    Trash2 as TrashIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Task } from "@solus/contracts/task-types";
  import type { TaskStatusCategory } from "@solus/contracts/task-sources";
  import type { PrReviewTab } from "../../contexts/prs/pr-view.svelte";
  import type { TaskPrChoice } from "./lib/task-list";
  import TaskPrMenuLabel from "./TaskPrMenuLabel.svelte";
  import { taskPrMenuTitle } from "./lib/task-pr-menu";
  import { askInsights } from "../insights/lib/ask-insights";
  import { getSurfaceContext } from "../../contexts";
  import { toasts } from "../../lib/toasts";
  import { requestInputFocus } from "../../lib/inputFocus";
  import * as ContextMenu from "../ui/context-menu";
  import TaskStatusGlyph from "../tasks/TaskStatusGlyph.svelte";
  import { CATEGORY_META, PROVIDER_NAMES, TASK_CATEGORIES } from "../tasks/lib/tasks-api";
  import { TASK_SNOOZE_CHOICES, taskSnoozeToastLabel, taskSnoozeUntil } from "./lib/task-snooze";

  interface Props {
    x: number;
    y: number;
    task: Task;
    hasLinkedSession: boolean;
    isRunning: boolean;
    onStart?: () => void;
    onResume?: () => void;
    onStop?: () => void;
    onOpenTask: () => void;
    onOpenSource?: () => void;
    prChoices?: TaskPrChoice[];
    onOpenPr?: (choice: TaskPrChoice, tab?: PrReviewTab) => void;
    onOpenPrWeb?: (choice: TaskPrChoice) => void;
    onUnlinkPr?: (choice: TaskPrChoice) => void;
    onStartRename?: () => void;
    /** Move the task to a status category. The menu mixes task sources, so
     *  the host chooses the column of each source. */
    onSetStatus?: (category: TaskStatusCategory) => void;
    /** Opens the full snooze menu, with its note and custom time, at the
     *  point the menu opened. Without it the submenu offers presets only. */
    onSnoozeCustom?: () => void;
    onRemove?: () => void;
    onDelete?: () => void;
    /** Opens the prompt that links a pull request to the task itself: one
     *  that no session of the task made. */
    onLinkPr?: () => void;
    /** The session a picker row stands for, so its id can be copied. */
    sessionId?: string | null;
    /** Where the menu portals to. It defaults to `body`, which is correct for a
     *  row in ordinary page chrome — but a caller that itself lives in the
     *  popover layer must name that layer, or the menu lands in a lower
     *  stacking context and paints *behind* the surface that summoned it. */
    portalTarget?: HTMLElement | null;
    onClose: () => void;
  }

  let {
    x,
    y,
    task,
    hasLinkedSession,
    isRunning,
    onStart,
    onResume,
    onStop,
    onOpenTask,
    onOpenSource,
    prChoices = [],
    onOpenPr,
    onOpenPrWeb,
    onUnlinkPr,
    onStartRename,
    onSetStatus,
    onSnoozeCustom,
    onRemove,
    onDelete,
    onLinkPr,
    sessionId = null,
    portalTarget = null,
    onClose,
  }: Props = $props();

  // The menu is drawn by the workspace and by the cloud console's task board
  // alike; Insights is a workspace pane.
  const session = getSurfaceContext();

  /** Every turn the task's sessions ran, in Insights. A task nothing has worked
   *  on yet has no turns to show, so the item appears once one attempt exists. */
  function openInInsights() {
    const taskId = task.id;
    onClose();
    const workspace = session.workspace;
    if (workspace) void askInsights({ kind: "task", taskId }, () => workspace.openInsights());
  }

  async function copyTaskId() {
    const id = task.id;
    onClose();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = id;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Task ID copied");
    } catch {
      toasts.error("Couldn't copy task ID");
    }
    requestInputFocus();
  }

  async function copySessionId() {
    const id = sessionId;
    onClose();
    if (!id) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(id);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = id;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success("Session ID copied");
    } catch {
      toasts.error("Couldn't copy session ID");
    }
    requestInputFocus();
  }

  function select(action: () => void) {
    action();
    onClose();
  }

  // A snooze is an attachment that the host that reads the task holds. A
  // client with no workspace has no such host.
  const canSnooze = $derived(!!session.workspace);
  const isSnoozed = $derived(!!task.snoozedUntil && task.snoozedUntil > Date.now());

  async function snooze(until: number | null) {
    const taskId = task.id;
    onClose();
    const record = session.tasksStore.get(taskId);
    try {
      await record.snooze(until);
      if (until !== null) {
        toasts.undo(taskSnoozeToastLabel({ count: 1, hasNote: false, keepsRunning: isRunning }), () => {
          void record.snooze(null).catch(() => toasts.error("Couldn't wake task"));
        });
      }
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : until === null ? "Couldn't wake task" : "Couldn't snooze task");
    }
    requestInputFocus();
  }

  async function copyPrValue(value: string, label: string) {
    onClose();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      toasts.success(`${label} copied`);
    } catch {
      toasts.error(`Couldn't copy ${label.toLowerCase()}`);
    }
    requestInputFocus();
  }
</script>

{#snippet prActions(choice: TaskPrChoice)}
  <ContextMenu.Item onSelect={() => select(() => onOpenPr?.(choice))}>
    <GitPullRequestIcon />
    Open pull request
  </ContextMenu.Item>
  <ContextMenu.Item onSelect={() => select(() => onOpenPr?.(choice, "diff"))}>
    <ListChecksIcon />
    Review changes
  </ContextMenu.Item>
  {#if onOpenPrWeb}
    <ContextMenu.Item onSelect={() => select(() => onOpenPrWeb(choice))}>
      <ArrowSquareOutIcon />
      Open in web
    </ContextMenu.Item>
  {/if}
  {#if choice.url || choice.pullRequest?.headRef}
    <ContextMenu.Separator />
    {#if choice.url}
      {@const url = choice.url}
      <ContextMenu.Item onSelect={() => void copyPrValue(url, "Pull request link")}>
        <CopyIcon />
        Copy pull request link
      </ContextMenu.Item>
    {/if}
    {#if choice.pullRequest?.headRef}
      {@const headRef = choice.pullRequest.headRef}
      <ContextMenu.Item onSelect={() => void copyPrValue(headRef, "Branch name")}>
        <CopyIcon />
        Copy branch name
      </ContextMenu.Item>
    {/if}
  {/if}
  {#if onUnlinkPr}
    <ContextMenu.Separator />
    <ContextMenu.Item variant="destructive" onSelect={() => select(() => onUnlinkPr(choice))}>
      <XIcon />
      Unlink from task
    </ContextMenu.Item>
  {/if}
{/snippet}

<ContextMenu.Root
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <ContextMenu.PointTrigger {x} {y} />
  <ContextMenu.Content
    class="min-w-48"
    portalProps={portalTarget ? { to: portalTarget } : undefined}
  >
    <ContextMenu.Item onSelect={copyTaskId}>
      <CopyIcon />
      Copy task ID
    </ContextMenu.Item>
    {#if sessionId}
      <ContextMenu.Item onSelect={copySessionId}>
        <CopyIcon />
        Copy session ID
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Separator />

    <ContextMenu.Item onSelect={() => select(onOpenTask)}>
      <TaskIcon />
      Open task
    </ContextMenu.Item>
    {#if onOpenSource && task.url}
      <ContextMenu.Item onSelect={() => select(onOpenSource)}>
        <ArrowSquareOutIcon />
        Open on {PROVIDER_NAMES[task.providerId]}
      </ContextMenu.Item>
    {/if}
    {#if onOpenPr && prChoices.length}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <GitPullRequestIcon />
          {prChoices.length === 1 ? `Pull request #${prChoices[0].number}` : `Pull requests (${prChoices.length})`}
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent class="w-72 min-w-0 max-w-[calc(100vw-2rem)] max-h-[min(20rem,var(--bits-context-menu-content-available-height))] overflow-y-auto overscroll-contain">
          {#if prChoices.length === 1}
            {@render prActions(prChoices[0])}
          {:else}
            {#each prChoices as choice (`${choice.targetScope}:${choice.number}`)}
              <div class="flex items-center">
                <ContextMenu.Item
                  class="min-w-0 flex-1 text-workspace-chrome"
                  title={`Open #${choice.number} ${taskPrMenuTitle(choice)}`}
                  onSelect={() => select(() => onOpenPr?.(choice))}
                >
                  <TaskPrMenuLabel {choice} />
                </ContextMenu.Item>
                <ContextMenu.Sub>
                  <ContextMenu.SubTrigger
                    class="shrink-0 text-workspace-chrome"
                    aria-label={`Actions for pull request #${choice.number}`}
                    title={`Actions for #${choice.number}`}
                  >
                    <span aria-hidden="true">…</span>
                  </ContextMenu.SubTrigger>
                  <ContextMenu.Portal to={portalTarget ?? undefined}>
                    <ContextMenu.SubContent class="min-w-48">
                      {@render prActions(choice)}
                    </ContextMenu.SubContent>
                  </ContextMenu.Portal>
                </ContextMenu.Sub>
              </div>
            {/each}
          {/if}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {/if}
    {#if onLinkPr}
      <ContextMenu.Item onSelect={() => select(onLinkPr)}>
        <GitPullRequestIcon />
        Link pull request…
      </ContextMenu.Item>
    {/if}
    {#if hasLinkedSession && session.workspace}
      <ContextMenu.Item onSelect={openInInsights}>
        <ChartBarIcon />
        Open in Insights
      </ContextMenu.Item>
    {/if}

    <ContextMenu.Separator />

    {#if isRunning && onStop}
      <ContextMenu.Item onSelect={() => select(onStop)}>
        <StopCircleIcon />
        Stop run
      </ContextMenu.Item>
    {/if}
    {#if onSetStatus}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <TaskStatusGlyph category={task.category} size={14} />
          Set status
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {#each TASK_CATEGORIES as category (category)}
            <ContextMenu.Item onSelect={() => select(() => onSetStatus?.(category))}>
              <TaskStatusGlyph {category} size={14} />
              {CATEGORY_META[category].label}
              {#if task.category === category}
                <CheckIcon class="ml-auto" />
              {/if}
            </ContextMenu.Item>
          {/each}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {/if}
    {#if canSnooze && isSnoozed}
      <ContextMenu.Item onSelect={() => void snooze(null)}>
        <SunIcon />
        Wake now
      </ContextMenu.Item>
    {:else if canSnooze}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <MoonIcon />
          Snooze
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {#each TASK_SNOOZE_CHOICES as choice (choice.preset)}
            <ContextMenu.Item onSelect={() => void snooze(taskSnoozeUntil(choice.preset))}>
              {choice.label}
            </ContextMenu.Item>
          {/each}
          {#if onSnoozeCustom}
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => select(onSnoozeCustom)}>
              Pick date and time…
            </ContextMenu.Item>
          {/if}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {/if}

    <ContextMenu.Separator />

    {#if onStartRename}
      <ContextMenu.Item onSelect={() => select(onStartRename)}>
        <PencilSimpleIcon />
        Rename task
      </ContextMenu.Item>
    {/if}
    {#if onRemove}
      <ContextMenu.Item variant="destructive" onSelect={() => select(onRemove)}>
        <XIcon />
        Remove from sidebar
      </ContextMenu.Item>
    {/if}
    {#if onDelete}
      <ContextMenu.Item variant="destructive" onSelect={() => select(onDelete)}>
        <TrashIcon />
        Delete task
      </ContextMenu.Item>
    {/if}
  </ContextMenu.Content>
</ContextMenu.Root>
