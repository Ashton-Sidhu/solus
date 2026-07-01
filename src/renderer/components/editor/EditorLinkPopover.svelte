<script lang="ts">
  import { fly } from "svelte/transition";
  import { CheckIcon } from "phosphor-svelte";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";

  interface Props {
    anchorCoords: { left: number; top: number; bottom: number };
    initialHref?: string;
    onSubmit: (href: string) => void;
    onCancel: () => void;
  }

  let { anchorCoords, initialHref = "", onSubmit, onCancel }: Props = $props();

  const layer = getPopoverLayer();
  let rootEl: HTMLDivElement | null = $state(null);
  let inputEl: HTMLInputElement | null = $state(null);
  let href = $state("");
  let hasFocused = false;

  $effect(() => {
    href = initialHref;
  });

  $effect(() => {
    if (!inputEl || hasFocused) return;
    hasFocused = true;
    inputEl.focus({ preventScroll: true });
    inputEl.select();
  });

  $effect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootEl || rootEl.contains(event.target as Node)) return;
      onCancel();
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => window.removeEventListener("pointerdown", handlePointerDown, true);
  });

  const posStyle = $derived.by(() => {
    const spaceBelow = window.innerHeight - anchorCoords.bottom;
    if (spaceBelow >= 120) {
      return `position:fixed;top:${anchorCoords.bottom + 6}px;left:${anchorCoords.left}px`;
    }
    return `position:fixed;bottom:${window.innerHeight - anchorCoords.top + 6}px;left:${anchorCoords.left}px`;
  });

  function submit() {
    const trimmed = href.trim();
    if (trimmed) onSubmit(trimmed);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  }
</script>

{#if layer.el}
  <div
    use:portal={layer.el}
    transition:fly={{ y: 4, duration: 140, opacity: 0 }}
    style={posStyle}
  >
    <div
      bind:this={rootEl}
      class="editor-link-popover flex items-center gap-1.5 rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) p-1.5"
      style="min-width:17rem;backdrop-filter:blur(1.25rem) saturate(1.1);-webkit-backdrop-filter:blur(1.25rem) saturate(1.1);box-shadow:var(--solus-popover-shadow)"
    >
      <input
        bind:this={inputEl}
        bind:value={href}
        onkeydown={handleKeydown}
        class="h-7 min-w-0 flex-1 rounded-md border-0 bg-transparent px-2 text-[0.75rem] leading-none text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary) focus:bg-(--solus-surface-hover)"
        type="text"
        placeholder="Paste or type a link…"
        aria-label="Link URL"
      />
      <button
        type="button"
        class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-(--solus-accent) text-(--solus-bg) transition-[transform,filter] duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) hover:brightness-105 active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] motion-reduce:transition-none"
        onclick={submit}
        aria-label="Apply link"
        title="Apply link"
      >
        <CheckIcon size={14} weight="bold" />
      </button>
    </div>
  </div>
{/if}
