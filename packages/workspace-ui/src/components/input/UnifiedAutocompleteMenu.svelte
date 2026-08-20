<script lang="ts">
  /*
   * One popover behind all three trigger characters. Categories and items are
   * the same row geometry and differ only by their leading glyph and trailing
   * slot: a count on a category, freshness or state on an item — never both.
   */
  import Icon from "@iconify/svelte";
  import { getPopoverLayer } from "../popoverLayer.svelte";
  import { portal } from "../portal";
  import { fileTypeIcon } from "../../lib/fileTypeIcon";
  import { ensureIconCollections } from "../diagram/iconify";
  import { GLYPH } from "../editor/unified-autocomplete/kinds";
  import type { TriggerChar } from "../editor/unified-autocomplete/trigger";
  import { runtime } from "../../contexts";
  import {
    isSelectable,
    inlineTitlePrefix,
    rowMeta,
    type MenuRow,
    type SelectableRow,
  } from "../editor/unified-autocomplete/rows";

  interface Props {
    rows: MenuRow[];
    triggerChar: TriggerChar;
    /** Index into the selectable rows only — labels and the header are skipped. */
    selectedIndex: number;
    anchorRect: DOMRect | null;
    onActivate: (row: SelectableRow) => void;
    onHover: (index: number, event: MouseEvent) => void;
    /** The scope's parent row doubles as the way back out of a drill. */
    onBack: () => void;
    enterVerb: string;
    tabVerb: string;
    showTabHint: boolean;
    footer: string;
    placement?: "up" | "down";
  }

  let {
    rows,
    triggerChar,
    selectedIndex,
    anchorRect,
    onActivate,
    onHover,
    onBack,
    enterVerb,
    tabVerb,
    showTabHint,
    footer,
    placement = "up",
  }: Props = $props();

  const layer = getPopoverLayer();
  ensureIconCollections();

  /* The spec's 394px was drawn against a 780px composer. Rather than fix the
     width and have it read narrow in a wide pane, the menu takes the composer's
     own width — bounded so it neither cramps a metadata column nor runs the
     rows so long that the trailing slot floats away from the title. */
  const MIN_WIDTH = $derived(runtime.isLaptopDisplay ? 420 : 480);
  const MAX_WIDTH = $derived(runtime.isLaptopDisplay ? 560 : 660);
  const titleWeight = $derived(
    triggerChar === "#" ? "font-normal" : "font-medium",
  );

  const width = $derived.by(() => {
    const preferred = Math.max(
      MIN_WIDTH,
      Math.min(MAX_WIDTH, Math.round(anchorRect?.width ?? MIN_WIDTH)),
    );
    // A narrow window wins over the floor: the menu must not run off-screen.
    return Math.min(preferred, window.innerWidth - 16);
  });

  /** Pair each row with its selectable index so the caret and the DOM agree. */
  const indexed = $derived.by(() => {
    let next = -1;
    return rows.map((row) => ({
      row,
      index: isSelectable(row) ? ++next : -1,
    }));
  });

  const selectedSession = $derived.by(() => {
    const selected = indexed.find((entry) => entry.index === selectedIndex)?.row;
    return selected?.type === "item" && selected.item.refKind === "session"
      ? selected.item
      : null;
  });

  let listEl: HTMLDivElement | null = $state(null);

  // Selection always scrolled into view with a 4px margin — the one thing that
  // moves without the user asking, so it stays minimal.
  $effect(() => {
    const el = listEl?.querySelector<HTMLElement>(
      `[data-row-index="${selectedIndex}"]`,
    );
    if (!el || !listEl?.clientHeight) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < listEl.scrollTop) listEl.scrollTop = Math.max(0, top - 4);
    else if (bottom > listEl.scrollTop + listEl.clientHeight)
      listEl.scrollTop = bottom - listEl.clientHeight + 4;
  });

  const left = $derived(
    anchorRect
      ? Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8))
      : 0,
  );
</script>

{#if anchorRect && layer.el && rows.length > 0}
  <div
    use:portal={layer.el}
    class="fixed z-30"
    style="pointer-events:auto;left:{left}px;width:{width}px;{placement ===
    'down'
      ? `top:${anchorRect.bottom + 4}px`
      : `bottom:${window.innerHeight - anchorRect.top + 4}px`}"
  >
    <div
      class="unified-menu text-workspace-chrome rounded-2xl bg-(--solus-popover-bg) p-1.5 pointer-fine:[.is-laptop-display_&]:rounded-xl pointer-fine:[.is-laptop-display_&]:p-1"
      style="box-shadow:var(--solus-popover-shadow), 0 0 0 0.03125rem var(--wash-ring);backdrop-filter:blur(1.25rem)"
    >
      <div
        bind:this={listEl}
        class="max-h-[22rem] overflow-x-hidden overflow-y-auto pointer-fine:[.is-laptop-display_&]:max-h-[18rem]"
        role="listbox"
        tabindex="-1"
      >
        {#each indexed as entry (entry.row.key)}
          {#if entry.row.type === "label"}
            {@render label(entry.row.label, entry.row.hint)}
          {:else if entry.row.type === "header"}
            {@render header(entry.row.label, entry.row.meta, entry.row.icon)}
          {:else}
            {@render row(entry.row, entry.index)}
          {/if}
        {/each}
      </div>

      {#if selectedSession?.preview}
        <div
          class="mx-0.5 mt-1.5 max-h-24 overflow-hidden px-2 pt-2 pb-1 pointer-fine:[.is-laptop-display_&]:mt-1 pointer-fine:[.is-laptop-display_&]:max-h-[4.75rem] pointer-fine:[.is-laptop-display_&]:px-1.5 pointer-fine:[.is-laptop-display_&]:pt-1.5"
        >
          <div
            class="mb-1 flex items-center gap-2 text-[0.75em] font-medium uppercase tracking-[0.06em] text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:mb-0.5"
          >
            <span>Opening prompt</span>
            <span class="h-px flex-1 bg-(--wash-rule)"></span>
          </div>
          <div
            class="line-clamp-3 leading-relaxed text-(--solus-text-secondary) text-pretty pointer-fine:[.is-laptop-display_&]:line-clamp-2"
          >
            {selectedSession.preview}
          </div>
        </div>
      {/if}

      <div class="mx-0.5 mt-[0.3125rem] h-px bg-(--wash-rule)"></div>
      <div
        class="flex items-center justify-between px-2 pt-[0.4375rem] pb-[0.1875rem] text-[0.875em] text-(--solus-text-tertiary) select-none pointer-fine:[.is-laptop-display_&]:px-1.5 pointer-fine:[.is-laptop-display_&]:pt-1.5"
      >
        <span class="flex items-center gap-[0.6875rem] pointer-fine:[.is-laptop-display_&]:gap-2">
          <span
            ><span class="font-mono text-(--solus-text-primary)">↑↓</span> move</span
          >
          <span
            ><span class="font-mono text-(--solus-text-primary)">⏎</span>
            {enterVerb}</span
          >
          {#if showTabHint}
            <span
              ><span class="font-mono text-(--solus-text-primary)">⇥</span>
              {tabVerb}</span
            >
          {/if}
        </span>
        {#if footer}
          <span class="font-mono opacity-80">{footer}</span>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#snippet glyph(path: string)}
  <svg
    width="13"
    height="13"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    class="size-[0.8125rem] pointer-fine:[.is-laptop-display_&]:size-3"
    aria-hidden="true"><path d={path} /></svg
  >
{/snippet}

{#snippet label(text: string, hint: string)}
  <div
    class="flex items-center gap-2.5 px-[0.5625rem] pt-[0.5625rem] pb-[0.3125rem] pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:px-[0.4375rem] pointer-fine:[.is-laptop-display_&]:pt-[0.4375rem] pointer-fine:[.is-laptop-display_&]:pb-1"
  >
    <span class="text-[0.875em] font-medium uppercase text-(--solus-text-tertiary)"
      >{text}</span
    >
    <span class="h-px flex-1 bg-(--wash-rule)"></span>
    {#if hint}
      <span class="font-mono text-[0.875em] text-(--solus-text-tertiary) opacity-70"
        >{hint}</span
      >
    {/if}
  </div>
{/snippet}

{#snippet header(text: string, meta: string, icon: string)}
  <!-- The category stays on screen as the first row and doubles as the way
       back, so the drill never loses its subject. -->
  <button
    type="button"
    class="flex h-[1.875rem] w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-[0.5625rem] text-left hover:bg-(--wash-hover) pointer-fine:[.is-laptop-display_&]:h-[1.625rem] pointer-fine:[.is-laptop-display_&]:gap-2 pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-[0.4375rem]"
    onclick={onBack}
  >
    <span class="flex w-4 shrink-0 items-center justify-center"
      >{@render glyph(icon)}</span
    >
    <span class="{titleWeight} text-(--solus-text-primary)"
      >{text}</span
    >
    <span class="text-[0.875em] text-(--solus-text-tertiary)">{meta}</span>
    <span class="flex-1"></span>
    <span class="font-mono text-[0.875em] text-(--solus-text-tertiary) opacity-70"
      >⌫ back</span
    >
  </button>
  <div
    class="mx-1 my-1 h-px bg-(--wash-rule) pointer-fine:[.is-laptop-display_&]:my-0.5"
    aria-hidden="true"
  ></div>
{/snippet}

{#snippet row(entry: SelectableRow, index: number)}
  {@const selected = index === selectedIndex}
  {@const isFileEntry =
    entry.type === "item" && entry.item.token.kind === "file"}
  {@const titlePrefix = inlineTitlePrefix(entry)}
  {@const iconName = isFileEntry ? fileTypeIcon(entry.item.token.path) : null}
  <button
    type="button"
    role="option"
    aria-selected={selected}
    data-row-index={index}
    class="flex h-[1.875rem] w-full cursor-pointer items-center gap-[0.5625rem] rounded-lg border-0 px-[0.5625rem] text-left transition-[background-color] duration-120 pointer-fine:[.is-laptop-display_&]:h-[1.625rem] pointer-fine:[.is-laptop-display_&]:gap-[0.4375rem] pointer-fine:[.is-laptop-display_&]:rounded-md pointer-fine:[.is-laptop-display_&]:px-[0.4375rem]"
    style="background:{selected ? 'var(--wash-selected)' : 'transparent'}"
    onmousemove={(event) => onHover(index, event)}
    onclick={() => onActivate(entry)}
  >
    {#if !titlePrefix}
      <span
        class="flex w-4 shrink-0 items-center justify-center text-(--solus-text-tertiary)"
        >{#if iconName}
          <Icon icon={iconName} width="14" height="14" />
        {:else}
          {@render glyph(
            entry.type === "category"
              ? entry.icon
              : entry.type === "item"
                ? entry.item.icon
                : entry.icon,
          )}
        {/if}</span
      >
    {/if}

    {#if entry.type === "deadEnd"}
      <!-- A dead end always offers a next move instead of an empty box. -->
      <span
        class="max-w-[20rem] shrink-0 overflow-hidden whitespace-nowrap {titleWeight} text-(--solus-text-tertiary)"
        >{entry.title}</span
      >
      <span class="min-w-0 flex-1 truncate text-[0.875em] text-(--solus-text-tertiary)"
        >{entry.meta}</span
      >
    {:else}
      {@const parts = entry.parts}
      {@const mono = entry.type === "item" && entry.item.mono}
      <span
        class="block max-w-[20rem] shrink-0 truncate text-(--solus-text-primary) {isFileEntry
          ? 'font-[450]'
          : titleWeight} {mono ? 'font-mono' : ''}"
      >
        <!-- Matched characters light up in every row; a metadata-only match
             lights nothing, because none of the title matched. -->
        {titlePrefix}{#each parts as part, i (i)}<span
            class="whitespace-pre"
            style={part.hit ? "color:var(--solus-accent)" : ""}
            >{part.text}</span
          >{/each}
      </span>

      {#if entry.type === "item"}
        <span
          class="min-w-0 flex-1 truncate text-[0.875em] text-(--solus-text-tertiary) {entry
            .item.monoMeta
            ? 'font-mono'
            : ''}">{rowMeta(entry.item, entry.showKind)}</span
        >
        {#if entry.item.when}
          <span
            class="shrink-0 font-mono text-[0.875em] text-(--solus-text-tertiary) opacity-75"
            >{entry.item.when}</span
          >
        {/if}
      {:else}
        <span class="flex-1"></span>
        <!-- A category's trailing slot is its count, and nothing else. -->
        <span
          class="flex shrink-0 items-center gap-2 text-(--solus-text-tertiary)"
        >
          <span class="font-mono text-[0.875em] tabular-nums opacity-55"
            >{entry.count}</span
          >
          <span class="opacity-40">{@render glyph(GLYPH.chevron)}</span>
        </span>
      {/if}
    {/if}
  </button>
{/snippet}

<style>
  /* The design's foreground-percentage washes, resolved against Solus text so
     they hold in both themes. */
  .unified-menu {
    --wash-selected: color-mix(
      in srgb,
      var(--solus-text-primary) 7%,
      transparent
    );
    --wash-hover: color-mix(in srgb, var(--solus-text-primary) 4%, transparent);
    --wash-rule: color-mix(in srgb, var(--solus-text-primary) 7%, transparent);
    --wash-ring: color-mix(in srgb, var(--solus-text-primary) 14%, transparent);
    animation: unified-menu-pop 200ms ease-out;
  }
  @keyframes unified-menu-pop {
    from {
      opacity: 0;
      transform: translateY(0.375rem) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .unified-menu {
      animation: none;
    }
  }
</style>
