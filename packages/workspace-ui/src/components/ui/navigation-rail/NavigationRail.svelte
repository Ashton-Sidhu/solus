<script lang="ts">
  let {
    class: className,
    label,
    items,
    activeIndex,
    onSelect,
  }: {
    class: string;
    label: string;
    items: readonly { id: string; label: string }[];
    activeIndex: number;
    onSelect: (id: string) => void;
  } = $props();

  let hovered = $state(false);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<nav
  class="rail no-scrollbar absolute z-20 flex -translate-y-1/2 flex-col items-start overflow-x-hidden overflow-y-auto rounded-[14px] border border-transparent p-1.5 {className}"
  class:expanded={hovered}
  aria-label={label}
  onmouseenter={() => (hovered = true)}
  onmouseleave={() => (hovered = false)}
>
  {#each items as item, index (item.id)}
    <button
      type="button"
      class="rail-row flex w-full shrink-0 cursor-pointer items-center rounded-[9px] py-[3px] text-(--solus-text-tertiary) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--solus-accent)"
      class:active={index === activeIndex}
      title={item.label}
      aria-label={item.label}
      aria-current={index === activeIndex ? "location" : undefined}
      onclick={() => onSelect(item.id)}
    >
      <span class="rail-dash block h-0.5 w-[11px] shrink-0 rounded-full bg-current opacity-50" aria-hidden="true"></span>
      <span class="rail-label text-workspace-chrome truncate text-left leading-tight">{item.label}</span>
    </button>
  {/each}
</nav>

<style>
  .rail {
    transition:
      background-color 0.16s ease,
      border-color 0.16s ease,
      box-shadow 0.16s ease;
  }

  .rail:is(.expanded, :has(:focus-visible)) {
    gap: 1px;
    background: var(--solus-container-bg);
    border-color: var(--solus-container-border);
    box-shadow: var(--solus-card-shadow-collapsed);
  }

  .rail:is(.expanded, :has(:focus-visible)) .rail-row {
    padding: 7px 11px;
  }

  .rail-label {
    max-width: 0;
    max-height: 0;
    opacity: 0;
    transition:
      max-width 0.18s ease,
      max-height 0.18s ease,
      opacity 0.14s ease;
  }

  .rail:is(.expanded, :has(:focus-visible)) .rail-label {
    max-width: 15rem;
    max-height: 1.5rem;
    opacity: 1;
  }

  .rail-dash {
    transition: opacity 0.16s ease, color 0.16s ease;
  }

  .rail-row.active {
    color: var(--solus-text-primary);
  }

  .rail-row.active .rail-dash {
    opacity: 1;
  }

  .rail:is(.expanded, :has(:focus-visible)) .rail-dash {
    display: none;
  }

  .rail:is(.expanded, :has(:focus-visible)) .rail-row:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .rail:is(.expanded, :has(:focus-visible)) .rail-row.active {
    background: var(--solus-surface-active);
  }

  @media (prefers-reduced-motion: reduce) {
    .rail,
    .rail-label,
    .rail-dash {
      transition: none;
    }
  }
</style>
