<script lang="ts">
  import { ListIcon, TreeViewIcon } from "phosphor-svelte";
  import type { SidebarViewMode } from "../../contexts/app/settings.context.svelte";

  interface Props {
    label: string;
    count: number;
    /** The view toggle, for a section that has one. The drafts section does not:
     *  a draft belongs to no project tree, so there is nothing to group it by. */
    mode?: SidebarViewMode;
    onModeChange?: (mode: SidebarViewMode) => void;
  }
  let {
    label,
    count,
    mode,
    onModeChange,
  }: Props = $props();

  // Selection, disclosure and scroll all survive a mode switch, so the toggle
  // is a lens over the same list rather than a second screen — which is why it
  // is two bare glyphs rather than a segmented plate. Ink alone says which is on.
  const segment =
    "flex size-6 cursor-pointer items-center justify-center rounded-[0.4375rem] transition-[background,color] duration-150";
  const segmentOn =
    "bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] text-foreground";
  const segmentOff =
    "text-muted-foreground hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)]";
</script>

<!-- The label starts on the same 10px inset every other row's content does, so
     the column keeps one left edge from the new-task bar down to the footer. -->
<div class="flex h-[2.625rem] flex-shrink-0 items-center gap-[0.5625rem] px-6">
  <span
    class="overflow-hidden text-[0.59375rem] font-semibold tracking-[0.12em] text-ellipsis whitespace-nowrap text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] uppercase"
    >{label}</span
  >
  <!-- A pill rather than a bare figure: it is the total the section is named
       for, not a per-row count, so it reads as part of the label. -->
  <span
    class="rounded-full bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] px-1.5 py-0.5 font-mono text-[0.59375rem] text-[color-mix(in_oklch,var(--foreground)_68%,transparent)] tabular-nums"
    >{count}</span
  >
  <div
    class="ml-auto flex items-center gap-0.5"
    role="group"
    aria-label="Task list view"
  >
    <button
      class="{segment} {mode === 'flat' ? segmentOn : segmentOff}"
      title="Flat list"
      aria-pressed={mode === "flat"}
      aria-label="Flat list"
      onclick={() => onModeChange("flat")}
    >
      <ListIcon size={13} />
    </button>
    <button
      class="{segment} {mode === 'grouped' ? segmentOn : segmentOff}"
      title="Group by project"
      aria-pressed={mode === "grouped"}
      aria-label="Group by project"
      onclick={() => onModeChange("grouped")}
    >
      <TreeViewIcon size={13} />
    </button>
  </div>
</div>
