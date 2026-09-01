<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Maximize2 as ArrowsOutSimpleIcon,
    ChevronLeft as CaretLeftIcon,
    LoaderCircle as CircleNotchIcon,
    MoreHorizontal as DotsIcon,
  } from "@lucide/svelte";
  import type { Task } from "@solus/contracts/task-types";
  import * as DropdownMenu from "../../ui/dropdown-menu";
  import { taskProviderLabel, taskRef } from "./lib/task-page";
  import type { TaskUpstreamState } from "./lib/task-upstream";

  /**
   * The task page's head at the record rung — back, what this is, everything
   * else.
   *
   * `TaskChromeBar` spends its width on a project crumb, an upstream pill and
   * six round 26px controls. None of that survives 393px, and none of it is
   * lost: the crumb becomes the subtitle under the reference, the pill and the
   * five controls become one overflow menu, and the sixth — back to the list —
   * becomes the leading arrow, because on a phone that is the move.
   */
  interface Props {
    task: Task;
    /** Which project the list behind this page is showing. */
    projectLabel: string;
    /** How this task stands with the system that owns its ticket. Null for a
     *  local task, which then has no upstream line in the menu. */
    upstream: TaskUpstreamState | null;
    syncing: boolean;
    onSync?: (() => void) | null;
    onPrevious?: (() => void) | null;
    onNext?: (() => void) | null;
    onOpenSource?: (() => void) | null;
    /** Replace an embedded detail panel with this task's standalone route. */
    onOpenPage?: () => void;
    onOpenList: () => void;
  }

  let {
    task,
    projectLabel,
    upstream,
    syncing,
    onSync,
    onPrevious,
    onNext,
    onOpenSource,
    onOpenPage,
    onOpenList,
  }: Props = $props();

  const providerLabel = $derived(taskProviderLabel(task));
</script>

<!-- The centred pair names the task by its reference and says which list the
     back arrow returns to, so the one control on the left never has to be
     guessed at. -->
<div
  class="flex h-14 shrink-0 items-center gap-1 border-b border-[var(--hairline)] px-2 text-workspace-chrome"
>
  <button
    type="button"
    class="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
    onclick={onOpenList}
    aria-label="Back to tasks"
  >
    <CaretLeftIcon size={19} />
  </button>

  <div class="flex min-w-0 flex-1 flex-col items-center gap-px">
    <span class="font-mono font-semibold tracking-[-0.004em]">
      {taskRef(task)}
    </span>
    <span class="max-w-full truncate text-xs text-muted-foreground">
      {projectLabel} · Tasks
    </span>
  </div>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-0 bg-transparent text-muted-foreground active:bg-[var(--wash-2)] [-webkit-tap-highlight-color:transparent]"
          aria-label="Task actions"
        >
          <DotsIcon size={19} />
        </button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" sideOffset={4} class="min-w-52">
      {#if upstream}
        <DropdownMenu.Label>
          {upstream.provider} · {upstream.ref}
        </DropdownMenu.Label>
      {/if}
      {#if onSync}
        <DropdownMenu.Item disabled={syncing} onSelect={() => onSync?.()}>
          <CircleNotchIcon
            size={14}
            class={syncing ? "animate-spin motion-reduce:animate-none" : ""}
          />
          <span class="flex-1 text-left"
            >{syncing ? "Syncing…" : "Sync now"}</span
          >
        </DropdownMenu.Item>
      {/if}
      {#if onOpenSource}
        <DropdownMenu.Item onSelect={() => onOpenSource?.()}>
          <ArrowSquareOutIcon size={14} />
          <span class="flex-1 text-left">Open in {providerLabel}</span>
        </DropdownMenu.Item>
      {/if}
      {#if onOpenPage}
        <DropdownMenu.Item onSelect={() => onOpenPage?.()}>
          <ArrowsOutSimpleIcon size={14} />
          <span class="flex-1 text-left">Open task page</span>
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Separator />
      <DropdownMenu.Item disabled={!onPrevious} onSelect={() => onPrevious?.()}>
        <span class="flex-1 text-left">Previous task</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item disabled={!onNext} onSelect={() => onNext?.()}>
        <span class="flex-1 text-left">Next task</span>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>
