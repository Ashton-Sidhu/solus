<script lang="ts">
  import { ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import type { SidebarShelf } from "./lib/sidebar-list-items";

  /** The header of a collapsible section of the sidebar list: Shared with you,
   *  Working, Snoozed, or Completed. Both sidebar views use it. */
  interface Props {
    section: SidebarShelf;
    count: number;
    isOpen: boolean;
    /** False when the section holds only the row on screen. A closed section
     *  still shows that row, so the header is a plain label with no toggle. */
    canToggle: boolean;
    onToggle: () => void;
  }
  let { section, count, isOpen, canToggle, onToggle }: Props = $props();
</script>

{#snippet label(text: string, color: string, hover: string)}
  {#if canToggle}
    <button
      type="button"
      class="-mx-2 flex h-7 w-[calc(100%+1rem)] cursor-pointer items-center gap-[0.5625rem] rounded-lg pr-2 pl-[0.625rem] text-chrome-shelf font-normal {color} transition-[color,background] duration-150 hover:bg-[color-mix(in_oklch,var(--foreground)_3.5%,transparent)] {hover}"
      aria-expanded={isOpen}
      onclick={onToggle}
    >
      {text}
      <span class="h-px min-w-4 flex-1 bg-sidebar-border/50" aria-hidden="true"></span>
      <span class="flex shrink-0 items-center gap-1.5">
        <span class="tabular-nums opacity-60">{count}</span>
        <span class="flex size-4 shrink-0 items-center justify-center">
          <CaretRightIcon size={14} class="transition-transform duration-150 {isOpen ? 'rotate-90' : ''}" />
        </span>
      </span>
    </button>
  {:else}
    <div
      class="-mx-2 flex h-7 w-[calc(100%+1rem)] items-center gap-[0.5625rem] pr-2 pl-[0.625rem] text-chrome-shelf font-normal {color}"
    >
      {text}
      <span class="h-px min-w-4 flex-1 bg-sidebar-border/50" aria-hidden="true"></span>
      <span class="tabular-nums opacity-60">{count}</span>
    </div>
  {/if}
{/snippet}

<div class="shrink-0" data-sidebar-section-header={section}>
  {#if section === "snoozed"}
    {@render label(
      "Snoozed",
      "text-(--solus-status-unread)",
      "hover:text-[color-mix(in_oklch,var(--solus-status-unread)_78%,var(--foreground))]",
    )}
  {:else}
    {@render label(
      section === "shared"
        ? "Shared with you"
        : section === "working"
          ? "Working"
          : "Completed",
      "text-muted-foreground",
      "hover:text-foreground",
    )}
  {/if}
</div>
