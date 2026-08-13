<script lang="ts">
  import { MoonIcon, NotePencilIcon } from "phosphor-svelte";
  import * as Popover from "../ui/popover";
  import { menuRowVariants } from "../ui/menu/menu-row";
  import { cn } from "@renderer/lib/tw";
  import {
    taskSnoozeAnchorTarget,
    taskSnoozeUntil,
    type TaskSnoozeAnchor,
    type TaskSnoozePreset,
  } from "./lib/task-snooze";

  interface Props {
    taskTitle: string;
    /** The control the menu drops from, or the point a context menu opened at. */
    anchor: TaskSnoozeAnchor;
    onConfirm: (until: number, note: string) => void;
    onClose: () => void;
  }
  let { taskTitle, anchor, onConfirm, onClose }: Props = $props();

  let open = $state(true);
  let note = $state("");
  let rowsEl: HTMLDivElement | undefined = $state();
  const anchorTarget = $derived(taskSnoozeAnchorTarget(anchor));

  const choices: Array<{ preset: TaskSnoozePreset; label: string }> = [
    { preset: "hour", label: "One hour" },
    { preset: "evening", label: "This evening" },
    { preset: "tomorrow", label: "Tomorrow morning" },
    { preset: "week", label: "Next week" },
  ];

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
</script>

<Popover.Root bind:open onOpenChange={(next) => { if (!next) onClose(); }}>
  <Popover.Content
    data-solus-ui
    customAnchor={anchorTarget}
    side="bottom"
    align="end"
    sideOffset={6}
    collisionPadding={8}
    aria-label={`Snooze ${taskTitle}`}
    class="menu-surface z-[10002] w-[260px] gap-0 rounded-2xl bg-(--solus-menu-bg) p-0 text-menu shadow-[shadow:var(--solus-menu-shadow)] ring-0 lg:text-menu"
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
      {#each choices as choice (choice.preset)}
        <button
          type="button"
          class={cn(menuRowVariants(), "w-full")}
          onclick={() => onConfirm(taskSnoozeUntil(choice.preset), note.trim())}
        >
          <MoonIcon size={13} class="shrink-0 text-(--solus-text-tertiary)" />
          <span class="min-w-0 flex-1 truncate text-left">{choice.label}</span>
        </button>
      {/each}
    </div>
  </Popover.Content>
</Popover.Root>
