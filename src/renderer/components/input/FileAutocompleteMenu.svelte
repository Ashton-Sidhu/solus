<script lang="ts">
  import { fly } from "svelte/transition";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";

  import type { FileMatch } from "../../../shared/types";

  interface Props {
    files: FileMatch[];
    onSelect: (file: FileMatch) => void;
    anchorRect: DOMRect | null;
    /** Whether the menu grows upward (above the cursor) or downward. */
    placement?: "up" | "down";
  }

  let { files, onSelect, anchorRect, placement = "up" }: Props = $props();

  const layer = getPopoverLayer();

  let listEl: HTMLDivElement | null = $state(null);
  let selectedIndex = $state(0);

  /** Split each display path into its dimmed parent prefix and emphasised name. */
  const rows = $derived(
    files.map((file) => {
      const idx = file.display.lastIndexOf("/");
      return { file, prefix: file.display.slice(0, idx + 1), name: file.display.slice(idx + 1) };
    }),
  );

  const rowHeight = 1.625; // rem
  const listHeight = $derived(
    Math.min(13, Math.max(rowHeight, files.length * rowHeight)),
  );

  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      listEl
        ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  }

  /** Called by InputBar when a new result set lands so Enter accepts the best match. */
  export function resetSelection(): void {
    selectedIndex = 0;
  }

  export function moveSelection(delta: -1 | 1): boolean {
    if (files.length === 0) return false;
    selectedIndex = (selectedIndex + delta + files.length) % files.length;
    scrollSelectedIntoView();
    return true;
  }

  export function getSelected(): FileMatch | null {
    return files[selectedIndex] ?? null;
  }

  export function acceptSelection(): boolean {
    const file = getSelected();
    if (!file) return false;
    onSelect(file);
    return true;
  }
</script>

{#if files.length > 0 && anchorRect && layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: placement === "down" ? 3 : -3, duration: 80 }}
    style="position:fixed;pointer-events:auto;{placement === 'down'
      ? `top:${anchorRect.bottom + 4}px`
      : `bottom:${window.innerHeight - anchorRect.top + 4}px`};left:{anchorRect.left +
      12}px;right:{window.innerWidth - anchorRect.right + 12}px"
  >
    <div
      class="rounded-[14px] bg-(--solus-popover-bg) border border-(--solus-popover-border) overflow-hidden"
      style="backdrop-filter:blur(1.25rem);box-shadow:var(--solus-popover-shadow)"
    >
      <div
        bind:this={listEl}
        class="overflow-y-auto py-0.5 transition-[height] duration-120 ease-in-out [&::-webkit-scrollbar]:w-[0.1875rem] [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--solus-text-tertiary)_40%,transparent)] [&::-webkit-scrollbar-track]:bg-transparent"
        style="height:{listHeight}rem"
        role="listbox"
      >
        {#each rows as row, i (row.file.path)}
          <button
            type="button"
            data-index={i}
            class="flex h-[1.625rem] w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left font-mono text-[0.75rem] font-normal text-(--solus-text-primary) hover:bg-(--solus-surface-hover)"
            class:bg-(--solus-accent-light)={i === selectedIndex}
            class:shadow-[inset_0.125rem_0_0_var(--solus-accent)]={i === selectedIndex}
            role="option"
            aria-selected={i === selectedIndex}
            onmousemove={() => (selectedIndex = i)}
            onclick={() => {
              selectedIndex = i;
              acceptSelection();
            }}
          >
            <svg
              class="size-[0.8125rem] flex-none text-(--solus-text-tertiary)"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              {#if row.file.isDir}
                <path
                  d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5.5A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5v-7Z"
                  fill="currentColor"
                  opacity="0.85"
                />
              {:else}
                <path
                  d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"
                  stroke="currentColor"
                  stroke-width="1.1"
                  opacity="0.85"
                />
                <path d="M9 2v3h3" stroke="currentColor" stroke-width="1.1" />
              {/if}
            </svg>
            <span class="min-w-0 truncate">
              {#if row.prefix}<span class="text-(--solus-text-tertiary)">{row.prefix}</span
                >{/if}<span class={i === selectedIndex ? 'text-(--solus-accent)' : 'text-(--solus-text-primary)'}>{row.name}{row.file.isDir ? "/" : ""}</span>
            </span>
          </button>
        {/each}
      </div>
      <div
        class="flex items-center gap-3 px-3 py-1 border-t border-(--solus-popover-border) text-[0.6875rem] text-(--solus-text-tertiary) select-none"
      >
        <span><kbd class="rounded border border-(--solus-popover-border) bg-(--solus-surface-hover) px-1 text-[0.625rem]">↑↓</kbd> navigate</span>
        <span><kbd class="rounded border border-(--solus-popover-border) bg-(--solus-surface-hover) px-1 text-[0.625rem]">⇥</kbd> enter dir</span>
        <span><kbd class="rounded border border-(--solus-popover-border) bg-(--solus-surface-hover) px-1 text-[0.625rem]">⏎</kbd> insert</span>
      </div>
    </div>
  </div>
{/if}
