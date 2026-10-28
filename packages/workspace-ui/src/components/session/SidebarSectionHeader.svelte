<script lang="ts">
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import type { SidebarSection } from "./lib/sidebar-list-items";

  /** The header of a collapsible section of the sidebar list: Shared with you,
   *  Working, Snoozed, or Completed. Both sidebar views use it. */
  interface Props {
    section: SidebarSection;
    count: number;
    isOpen: boolean;
    /** The entry above is a header too, so a closed section takes no extra gap. */
    followsHeader: boolean;
    /** A row follows the header. A closed section still shows the row on
     *  screen, so the gap follows the rows, not `isOpen`. */
    hasRowsBelow: boolean;
    onToggle: () => void;
  }
  let { section, count, isOpen, followsHeader, hasRowsBelow, onToggle }: Props = $props();
</script>

{#if section === "snoozed"}
  <!-- The extra space sets the shelves apart from the cards above.
       Below a closed header there are no cards, so it takes the same
       gap as one header below another. -->
  <div class={followsHeader ? "mt-2" : "mt-3"}>
    <button
      type="button"
      class="-mx-2 flex h-7 w-[calc(100%+1rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] text-chrome-shelf font-normal text-(--solus-status-unread) transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] hover:text-[color-mix(in_oklch,var(--solus-status-unread)_78%,var(--foreground))]"
      aria-expanded={isOpen}
      onclick={onToggle}
    >
      Snoozed
      <span class="h-px min-w-4 flex-1 bg-sidebar-border/50" aria-hidden="true"></span>
      <span class="tabular-nums opacity-60">{count}</span>
      <span class="flex size-4 shrink-0 items-center justify-center">
        <CaretRightIcon size={14} class="transition-transform duration-150 {isOpen ? 'rotate-90' : ''}" />
      </span>
    </button>
  </div>
{:else}
  <!-- Working holds the rows whose agent is busy without you; it and
       Completed take the same header. A section that opens the list
       needs no space above it. -->
  <div
    class="mt-2 first:mt-0 {section === 'completed' || (section === 'working' && !hasRowsBelow)
      ? ''
      : 'mb-1'}"
  >
    <button
      type="button"
      class="-mx-2 flex h-7 w-[calc(100%+1rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] text-chrome-shelf font-normal text-muted-foreground transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] hover:text-foreground"
      aria-expanded={isOpen}
      onclick={onToggle}
    >
      {section === "shared" ? "Shared with you" : section === "working" ? "Working" : "Completed"}
      <span class="h-px min-w-4 flex-1 bg-sidebar-border/50" aria-hidden="true"></span>
      <span class="tabular-nums opacity-60">{count}</span>
      <span class="flex size-4 shrink-0 items-center justify-center">
        <CaretRightIcon size={14} class="transition-transform duration-150 {isOpen ? 'rotate-90' : ''}" />
      </span>
    </button>
  </div>
{/if}
