<script lang="ts">
  import { tick } from "svelte";
  import { Network as ArchitectureIcon, Search as MagnifyingGlassIcon, X as XIcon } from "@lucide/svelte";
  import { portal } from "../portal";
  import type { DiagramEmbedChoice } from "./diagramEmbedExtension";

  interface Props {
    choices: DiagramEmbedChoice[];
    onSelect: (choice: DiagramEmbedChoice) => void;
    onClose: () => void;
  }

  let { choices, onSelect, onClose }: Props = $props();
  let query = $state("");
  let selectedIndex = $state(0);
  let input: HTMLInputElement | null = $state(null);

  const filtered = $derived(
    choices.filter((choice) => choice.title.toLowerCase().includes(query.trim().toLowerCase())),
  );

  $effect(() => {
    void tick().then(() => input?.focus());
  });

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length) selectedIndex = (selectedIndex + 1) % filtered.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length) selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
    } else if (event.key === "Enter" && filtered[selectedIndex]) {
      event.preventDefault();
      onSelect(filtered[selectedIndex]);
    }
  }
</script>

<div
  use:portal={document.body}
  class="fixed inset-0 z-[11000] flex items-center justify-center bg-black/30 p-4 max-sm:items-end max-sm:p-0"
  role="presentation"
  onclick={(event) => event.target === event.currentTarget && onClose()}
  onkeydown={handleKeydown}
>
  <div
    class="w-full max-w-md overflow-hidden rounded-2xl border border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-2xl max-sm:max-w-none max-sm:rounded-b-none"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Embed diagram"
  >
    <header class="flex items-center gap-2 border-b border-(--solus-container-border) px-4 py-3">
      <ArchitectureIcon size={16} class="text-(--solus-accent)" />
      <h2 class="min-w-0 flex-1 text-sm font-semibold text-(--solus-text-primary)">Embed diagram</h2>
      <button type="button" class="rounded-lg p-1 text-(--solus-text-tertiary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary)" aria-label="Close" onclick={onClose}>
        <XIcon size={15} />
      </button>
    </header>
    <div class="border-b border-(--solus-container-border) p-2.5">
      <label class="flex items-center gap-2 rounded-xl bg-(--solus-surface-primary) px-3 py-2">
        <MagnifyingGlassIcon size={14} class="text-(--solus-text-tertiary)" />
        <input bind:this={input} bind:value={query} oninput={() => (selectedIndex = 0)} class="min-w-0 flex-1 border-0 bg-transparent text-sm text-(--solus-text-primary) outline-none placeholder:text-(--solus-text-tertiary)" placeholder="Search diagrams…" />
      </label>
    </div>
    <div class="max-h-80 overflow-y-auto p-2">
      {#if filtered.length === 0}
        <div class="px-4 py-10 text-center text-sm text-(--solus-text-tertiary)">
          {choices.length === 0 ? "No diagrams are available" : "No matching diagrams"}
        </div>
      {:else}
        {#each filtered as choice, index (choice.workId)}
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-(--solus-surface-hover) {index === selectedIndex ? 'bg-(--solus-surface-hover)' : ''}"
            onmouseenter={() => (selectedIndex = index)}
            onclick={() => onSelect(choice)}
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-accent-light) text-(--solus-accent)"><ArchitectureIcon size={15} /></span>
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-(--solus-text-primary)">{choice.title}</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>
