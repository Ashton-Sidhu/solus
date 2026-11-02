<script lang="ts">
  import { useScope } from "../../lib/keybindings/use-keybinding.svelte";
  import {
    CalendarClock as CalendarClockIcon,
    Clock as ClockIcon,
    Moon as MoonIcon,
    NotebookPen as NotePencilIcon,
  } from "@lucide/svelte";
  import { Dialog } from "bits-ui";
  import { Input } from "../ui/input";
  import * as Popover from "../ui/popover";
  import { menuRowVariants } from "../ui/menu/menu-row";
  import DateTimePicker from "../ui/DateTimePicker.svelte";
  import { Button } from "../ui/button";
  import { cn } from "@solus/workspace-ui/lib/tw";
  import { formatResetClock } from "../../lib/sessionUtils";
  import {
    TASK_SNOOZE_CHOICES,
    customSnoozeUntil,
    limitResetSnoozeUntil,
    snoozePickerValue,
    taskSnoozeAnchorTarget,
    taskSnoozeUntil,
    type TaskSnoozeAnchor,
  } from "./lib/task-snooze";

  interface Props {
    taskTitle: string;
    /** The control the menu drops from, or the point a context menu opened at. */
    anchor: TaskSnoozeAnchor;
    /** The context submenu already offered presets; open its custom form directly. */
    customTime?: boolean;
    /** While the session is rate limited: when its provider window reopens,
     *  in epoch ms. Adds "Until limit resets" when it is known and ahead. */
    limitResetsAt?: number;
    onConfirm: (until: number, note: string) => void;
    onClose: () => void;
  }
  let { taskTitle, anchor, customTime = false, limitResetsAt, onConfirm, onClose }: Props = $props();

  // The clock is read once: the menu is short-lived, and a choice must not
  // vanish under the pointer.
  const openedAt = Date.now();
  const limitResetUntil = $derived(limitResetSnoozeUntil(limitResetsAt, openedAt));

  let open = $state(true);
  let note = $state("");
  // The custom time opens on the "Tomorrow morning" preset, the usual
  // starting point for a time of one's own.
  let isCustomOpen = $state(false);
  let customValue = $state(snoozePickerValue(taskSnoozeUntil("tomorrow", new Date(openedAt))));
  const customUntil = $derived(customSnoozeUntil(customValue, openedAt));
  let rowsEl: HTMLDivElement | undefined = $state();
  let customEl = $state<HTMLElement | null>(null);
  const noteId = $props.id();
  const anchorTarget = $derived(taskSnoozeAnchorTarget(anchor));

  /** Presets take focus on open, so the menu answers ↓/↑/⏎ the way every other
   *  menu does. The note is one Shift+Tab away for the rarer case. */
  function focusRow(step: number, from: HTMLElement) {
    const rows = [...(rowsEl?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const next = rows[(rows.indexOf(from) + step + rows.length) % rows.length];
    next?.focus();
  }

  function onRowsKeydown(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (event.target instanceof HTMLElement) {
      focusRow(event.key === "ArrowDown" ? 1 : -1, event.target);
    }
  }

  // A modal: shortcuts behind it stay quiet while it is open.
  useScope("modal-dialog", { exclusive: true, pre: true, active: () => open && (customTime || isCustomOpen) });
</script>

{#if customTime || isCustomOpen}
  <Dialog.Root bind:open onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay class="fixed inset-0 z-[10008] modal-backdrop" />
      <Dialog.Content
        bind:ref={customEl}
        data-solus-ui
        class="fixed top-1/2 left-1/2 z-[10009] flex max-h-[calc(100dvh-2rem)] w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-5 text-workspace-chrome text-foreground shadow-[var(--solus-popover-shadow)] outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          customEl?.querySelector<HTMLElement>('[data-selected][role="button"]')?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div class="flex min-w-0 flex-col gap-1">
          <Dialog.Title class="font-medium">Snooze until</Dialog.Title>
          <Dialog.Description class="truncate text-muted-foreground" title={taskTitle}>
            {taskTitle}
          </Dialog.Description>
        </div>
        <DateTimePicker
          expanded
          value={customValue}
          onChange={(next) => (customValue = next)}
          class="w-full"
        />
        <div class="flex flex-col gap-1.5">
          <label for={noteId}>Reminder note (optional)</label>
          <Input id={noteId} name="snoozeNote" bind:value={note} placeholder="What should you return to?" />
        </div>
        {#if customUntil === null}
          <p class="text-destructive" role="status">Choose a time in the future.</p>
        {/if}
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onclick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={customUntil === null}
            onclick={() => {
              if (customUntil !== null) onConfirm(customUntil, note.trim());
            }}
          >Snooze</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{:else}
<Popover.Root bind:open onOpenChange={(next) => { if (!next) onClose(); }}>
  <Popover.Content
    data-solus-ui
    customAnchor={anchorTarget}
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    aria-label={`Snooze ${taskTitle}`}
    class="menu-surface z-[10002] w-[260px] pointer-coarse:w-[300px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-menu"
    onCloseAutoFocus={(event) => { if (isCustomOpen) event.preventDefault(); }}
    onOpenAutoFocus={(event) => {
      event.preventDefault();
      rowsEl?.querySelector("button")?.focus();
    }}
  >
    <div
      class="flex items-center gap-2 border-b border-(--solus-menu-hairline) px-3 pt-2.5 pb-2 text-(--solus-text-tertiary)"
    >
      <NotePencilIcon size={13} class="shrink-0 opacity-70" />
      <input
        bind:value={note}
        aria-label="Reminder note"
        placeholder="Reminder note (optional)"
        class="h-4 flex-1 bg-transparent text-menu text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)"
      />
    </div>
    <div bind:this={rowsEl} class="p-1.5" onkeydown={onRowsKeydown} role="none">
      {#if limitResetUntil}
        <button
          type="button"
          class={cn(menuRowVariants(), "w-full")}
          onclick={() => onConfirm(limitResetUntil, note.trim())}
        >
          <ClockIcon size={13} class="shrink-0 text-(--warning)" />
          <span class="min-w-0 flex-1 truncate text-left">Until limit resets</span>
          <span class="shrink-0 text-(--solus-text-tertiary)">{formatResetClock(limitResetUntil)}</span>
        </button>
      {/if}
      {#each TASK_SNOOZE_CHOICES as choice (choice.preset)}
        {@const ChoiceIcon = choice.isRelative ? ClockIcon : MoonIcon}
        <button
          type="button"
          class={cn(menuRowVariants(), "w-full")}
          onclick={() => onConfirm(taskSnoozeUntil(choice.preset), note.trim())}
        >
          <ChoiceIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate text-left">{choice.label}</span>
        </button>
      {/each}
      <button
        type="button"
        class={cn(menuRowVariants(), "w-full")}
        aria-haspopup="dialog"
        onclick={() => (isCustomOpen = true)}
      >
        <CalendarClockIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
        <span class="min-w-0 flex-1 truncate text-left">Pick date and time…</span>
      </button>
    </div>
  </Popover.Content>
</Popover.Root>

{/if}
