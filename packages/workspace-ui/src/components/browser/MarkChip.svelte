<script lang="ts">
  import {
    MousePointerClick,
    PenLine,
    Square,
    X as XIcon,
  } from "@lucide/svelte";
  import type { BrowserMarkChip } from "../../lib/browser-annotation";
  import type { Component } from "svelte";

  /**
   * One mark from the browser pane, once it enters the conversation.
   *
   * The pin is the identity: the same number the overlay drew on the page, the
   * prompt lists, and the agent names back. A chip is how that pin travels, so
   * it is carried from the annotation store and never derived from where the
   * chip sits in the row.
   *
   * One shell in two forms. Composing, it is a control — removable, its ring
   * warming on hover. Sent, it is a record — no remove, a real border, and a
   * click that reopens the pane at the page the mark was made on. The glyphs are
   * the pane's own tool icons rather than a second set, so a chip and the pill
   * that made it cannot disagree about which tool was used.
   */
  interface Props {
    chip: BrowserMarkChip;
    /** The sent form: the message chip family, alongside file and PR refs. */
    sent?: boolean;
    /** Composer only. Removing a chip also clears its mark from the pane. */
    onRemove?: () => void;
    /** Sent only, and absent once the page it points at is gone. */
    onOpen?: () => void;
  }

  let { chip, sent = false, onRemove, onOpen }: Props = $props();

  const TOOL_ICONS = {
    pick: MousePointerClick,
    region: Square,
    draw: PenLine,
  } satisfies Record<BrowserMarkChip["tool"], Component>;
  const ToolIcon = $derived(TOOL_ICONS[chip.tool]);
</script>

{#snippet shell()}
  <!-- The glyph is never dropped, however tight the row: a note on an element
       and a box drawn around a region are different instructions. -->
  <span class="flex shrink-0 items-center text-(--solus-text-tertiary) opacity-55" aria-hidden="true">
    <ToolIcon size={11} strokeWidth={1.7} />
  </span>
  <span
    class="flex size-4 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold tracking-tight tabular-nums {chip.resolved
      ? 'bg-primary text-[color:var(--primary-foreground)]'
      : 'text-(--solus-text-tertiary) shadow-[inset_0_0_0_1.5px_var(--idle)]'}"
  >
    {chip.pin}
  </span>
  <span
    class="max-w-[12.5rem] shrink-0 truncate {chip.isQuote ? '' : 'font-mono'} {chip.resolved
      ? ''
      : 'text-(--solus-text-tertiary) line-through decoration-[var(--idle)]'}"
  >
    {chip.label}
  </span>
  {#if chip.host}
    <!-- Where the mark came from, on every chip. The host never gives: two
         worktrees serving one app differ only in it. The path is what shortens.
         The theme appears only when the page was not on the app's own — the one
         fact about the capture a reader cannot infer. -->
    <span class="flex min-w-0 items-center text-(--solus-text-tertiary) opacity-60">
      <span class="shrink-0">{chip.host}</span>
      {#if chip.path}
        <span class="truncate">{chip.path}</span>
      {/if}
      {#if chip.theme}
        <span class="shrink-0 whitespace-pre"> · {chip.theme}</span>
      {/if}
    </span>
  {/if}
  {#if onRemove}
    <button
      type="button"
      onclick={onRemove}
      aria-label="Remove mark {chip.pin}"
      class="flex size-5 shrink-0 items-center justify-center rounded-md text-(--solus-text-tertiary) opacity-55 [.is-laptop-display_&]:size-4.5 transition-[background-color,color,opacity] duration-[var(--duration-quick)] hover:bg-[var(--wash-2)] hover:text-(--solus-text-primary) hover:opacity-100 focus-visible:bg-[var(--wash-2)] focus-visible:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--ring) focus-visible:ring-offset-1"
    >
      <XIcon size={10} strokeWidth={2} />
    </button>
  {/if}
{/snippet}

{#if sent && onOpen}
  <button
    type="button"
    onclick={onOpen}
    title={chip.title}
    data-testid="mark-chip"
    class="text-chrome-shelf inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 rounded-md border border-[color-mix(in_oklch,var(--foreground)_11%,transparent)] bg-card pr-1.5 pl-[0.1875rem] transition-colors hover:border-[color-mix(in_oklch,var(--primary)_55%,transparent)] focus-visible:border-[color-mix(in_oklch,var(--primary)_55%,transparent)] focus-visible:outline-none [.is-laptop-display_&]:h-[1.375rem]"
  >
    {@render shell()}
  </button>
{:else}
  <span
    title={chip.title}
    data-testid="mark-chip"
    class="text-chrome-shelf inline-flex max-w-full shrink-0 items-center gap-1.5 bg-card {sent
      ? 'h-6 rounded-md border border-[color-mix(in_oklch,var(--foreground)_11%,transparent)] pr-1.5 pl-[0.1875rem] [.is-laptop-display_&]:h-[1.375rem]'
      : 'h-6.5 rounded-lg pr-[0.1875rem] pl-1 shadow-[shadow:inset_0_0_0_0.5px_color-mix(in_oklch,var(--foreground)_12%,transparent)] transition-shadow hover:shadow-[shadow:inset_0_0_0_0.5px_color-mix(in_oklch,var(--primary)_45%,transparent)] [.is-laptop-display_&]:h-6'}"
  >
    {@render shell()}
  </span>
{/if}
