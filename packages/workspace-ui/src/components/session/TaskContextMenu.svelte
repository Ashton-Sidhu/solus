<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    ChartBar as ChartBarIcon,
    MessageCircleMore as ChatCircleDotsIcon,
    Check as CheckIcon,
    Copy as CopyIcon,
    GitPullRequest as GitPullRequestIcon,
    ListChecks as ListChecksIcon,
    Play as PlayIcon,
    Pen as PencilSimpleIcon,
    RefreshCw as ArrowsClockwiseIcon,
    CircleStop as StopCircleIcon,
    Trash2 as TrashIcon,
    X as XIcon,
  } from "@lucide/svelte";
  import type { Task, TaskStatus } from "@solus/contracts/task-types";
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
  import UnreadDot from "./UnreadDot.svelte";
  import { STATUS_META, TASK_STATUSES } from "../tasks/lib/tasks-api";

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
    onSetStatus?: (status: TaskStatus) => void;
    onMarkUnread?: () => void;
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
    onMarkUnread,
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

  async function regenerateTitle() {
    const taskId = task.id;
    onClose();
    const progress = toasts.progress("Regenerating task title…");
    try {
      await session.tasksStore.get(taskId).regenerateTitle();
      progress.success("Task title regenerated");
    } catch (error) {
      progress.error(error instanceof Error ? error.message : "Couldn't regenerate task title");
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
      <ListChecksIcon />
      Open task
    </ContextMenu.Item>
    {#if onOpenSource && task.url}
      <ContextMenu.Item onSelect={() => select(onOpenSource)}>
        <ArrowSquareOutIcon />
        Open source ticket
      </ContextMenu.Item>
    {/if}
    {#if onOpenPr && prChoices.length}
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>
          <GitPullRequestIcon />
          {prChoices.length === 1 ? `Pull request #${prChoices[0].number}` : `Pull requests (${prChoices.length})`}
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent class="w-80 min-w-0 max-w-[calc(100vw-2rem)] max-h-[min(24rem,var(--bits-context-menu-content-available-height))] overflow-y-auto overscroll-contain">
          {#if prChoices.length === 1}
            {@render prActions(prChoices[0])}
          {:else}
            {#each prChoices as choice (`${choice.targetScope}:${choice.number}`)}
              <div class="flex items-center">
                <ContextMenu.Item
                  class="h-auto min-w-0 flex-1 py-2 text-workspace-chrome"
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
          <TaskStatusGlyph status={task.status} size={14} />
          Set status
        </ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {#each TASK_STATUSES as status}
            <ContextMenu.Item onSelect={() => select(() => onSetStatus?.(status))}>
              <TaskStatusGlyph {status} size={14} />
              {STATUS_META[status].label}
              {#if task.status === status}
                <CheckIcon class="ml-auto" />
              {/if}
            </ContextMenu.Item>
          {/each}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    {/if}
    {#if onMarkUnread}
      <ContextMenu.Item onSelect={() => select(onMarkUnread)}>
        <UnreadDot size={14} />
        Mark unread
      </ContextMenu.Item>
    {/if}

    <ContextMenu.Separator />

    {#if onStartRename}
      <ContextMenu.Item onSelect={() => select(onStartRename)}>
        <PencilSimpleIcon />
        Rename task
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item onSelect={regenerateTitle}>
      <ArrowsClockwiseIcon />
      Regenerate title
    </ContextMenu.Item>
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
