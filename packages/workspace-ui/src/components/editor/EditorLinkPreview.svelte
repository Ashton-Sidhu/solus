<script lang="ts">
  import {
    ExternalLink as ArrowSquareOutIcon,
    Link2 as LinkSimpleIcon,
    Pencil as PencilSimpleIcon,
    Unlink as LinkBreakIcon,
  } from "@lucide/svelte";
  import { fly } from "svelte/transition";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import { linkDestinationLabel } from "./lib/link-preview";

  interface Props {
    anchorCoords: { left: number; top: number; bottom: number };
    href: string;
    onOpen: () => void;
    onEdit: () => void;
    onRemove: () => void;
    onClose: () => void;
  }

  let { anchorCoords, href, onOpen, onEdit, onRemove, onClose }: Props = $props();

  const layer = getPopoverLayer();
  let rootEl: HTMLDivElement | null = $state(null);
  const destination = $derived(linkDestinationLabel(href));
  const posStyle = $derived.by(() => {
    const width = Math.min(352, window.innerWidth - 16);
    const left = Math.min(
      Math.max(8, anchorCoords.left),
      Math.max(8, window.innerWidth - width - 8),
    );
    const spaceBelow = window.innerHeight - anchorCoords.bottom;
    if (spaceBelow >= 152) {
      return `position:fixed;top:${anchorCoords.bottom + 6}px;left:${left}px;width:${width}px`;
    }
    return `position:fixed;bottom:${window.innerHeight - anchorCoords.top + 6}px;left:${left}px;width:${width}px`;
  });

  $effect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootEl || !(event.target instanceof Node) || rootEl.contains(event.target)) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  });
</script>

{#if layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: 4, duration: 140, opacity: 0 }}
    style={posStyle}
  >
    <div
      bind:this={rootEl}
      class="rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1.5 text-(--solus-text-primary)"
      style="backdrop-filter:blur(1.25rem) saturate(1.1);-webkit-backdrop-filter:blur(1.25rem) saturate(1.1);box-shadow:var(--solus-popover-shadow)"
      role="dialog"
      aria-label="Link preview"
    >
      <button
        type="button"
        class="flex min-h-10 w-full min-w-0 overflow-hidden cursor-pointer items-center gap-2.5 rounded-[0.625rem] px-2.5 text-left transition-[background-color,transform] duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) hover:bg-(--solus-surface-hover) active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] motion-reduce:transition-none"
        onclick={onOpen}
        title="Open link"
      >
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-secondary)">
          <LinkSimpleIcon size={15} />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium">{destination}</span>
          <span class="block truncate text-[0.6875rem] text-(--solus-text-tertiary)">{href}</span>
        </span>
        <ArrowSquareOutIcon class="shrink-0 text-(--solus-text-tertiary)" size={14} />
      </button>

      <div class="mt-1 flex items-center gap-1 border-t border-(--solus-container-border) pt-1">
        <button
          type="button"
          class="flex min-h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[0.625rem] px-2 text-xs text-(--solus-text-secondary) transition-[background-color,transform] duration-(--duration-quick,120ms) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] motion-reduce:transition-none"
          onclick={onEdit}
        >
          <PencilSimpleIcon size={13} />
          Edit
        </button>
        <button
          type="button"
          class="flex min-h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[0.625rem] px-2 text-xs text-(--solus-text-secondary) transition-[background-color,transform] duration-(--duration-quick,120ms) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] motion-reduce:transition-none"
          onclick={onRemove}
        >
          <LinkBreakIcon size={13} />
          Remove link
        </button>
      </div>
      <p class="px-2.5 pt-1 pb-0.5 text-[0.625rem] text-(--solus-text-tertiary)">
        ⌘/Ctrl-click opens the link directly
      </p>
    </div>
  </div>
{/if}
