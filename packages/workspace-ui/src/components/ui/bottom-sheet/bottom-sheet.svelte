<script lang="ts">
  import type { Snippet } from "svelte";
  import { portal } from "../../portal";

  /**
   * A surface raised from the bottom edge, for a pane too narrow to put it
   * anywhere else.
   *
   * This is the stacked-pane answer to two different desktop shapes — a column
   * beside the content (the task's properties) and a card hanging off a row
   * (the workspace peek) — because neither has room to be itself below 30rem,
   * and both are read the same way once they are here: raised over the page,
   * dismissed back to exactly the scroll position they were raised from.
   *
   * It stops short of the top on purpose. A sheet that covers the whole screen
   * is a page, and a reader has to be able to see what they will return to.
   *
   * Portalled to the body, so it is never clipped by a pane's `overflow` and
   * never inherits a transformed ancestor's coordinate space.
   *
   * It stacks above the `z-[200]` band the full-window modals use — the task
   * picker, the directory picker, the project and import dialogs. A sheet is
   * always raised *from* something, and on a phone that something is usually
   * one of those, painting opaque edge to edge. At `z-50` the sheet mounted,
   * animated, took the keyboard and was never visible: it was behind the
   * surface that summoned it. The band above 9990 belongs to the app shell and
   * its toasts, and is deliberately left alone.
   */
  interface Props {
    /** Named for assistive technology, and by the thing the sheet is about. */
    label: string;
    onClose: () => void;
    /** Pinned above the scrolling body — a title and its Done, typically. */
    header?: Snippet;
    /** Pinned below it: the one action the sheet exists to offer. */
    footer?: Snippet;
    /**
     * Where the sheet mounts. The body by default; a sheet raised from inside
     * a surface that itself sits in the popover layer must mount there too, or
     * it paints beneath the scrim that summoned it.
     */
    portalTarget?: HTMLElement | null;
    children: Snippet;
  }
  let { label, onClose, header, footer, portalTarget = null, children }: Props = $props();
  const mountIn = $derived(portalTarget ?? document.body);
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key !== "Escape") return;
    // Claimed before the page behind it can read the same key as "close the
    // page": the topmost surface owns Escape.
    event.stopPropagation();
    onClose();
  }}
/>

<!-- The backdrop is a button in everything but name — tapping it dismisses —
     but it carries no label of its own, because the sheet's own close control
     is the labelled way out and a second one would be read aloud as noise. -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  use:portal={mountIn}
  class="pointer-events-auto fixed inset-0 z-[210] bg-black/45"
  onclick={onClose}
></div>

<div
  use:portal={mountIn}
  class="bottom-sheet text-chrome-dense pointer-events-auto fixed inset-x-0 bottom-0 z-[211] flex max-h-[82dvh] flex-col rounded-t-[26px] bg-background text-left shadow-[shadow:0_0_0_0.5px_var(--hairline-strong),0_-20px_50px_-18px_rgba(0,0,0,0.5)] pointer-fine:[.is-laptop-display_&]:rounded-t-[20px]"
  role="dialog"
  aria-modal="true"
  aria-label={label}
>
  <!-- The grab bar. It is the one part of a sheet a thumb reads before the
       words: it says which edge this came from and which edge sends it back. -->
  <div class="flex shrink-0 justify-center pt-[9px] pb-[3px]" aria-hidden="true">
    <span class="h-1 w-[38px] rounded-full bg-foreground opacity-20"></span>
  </div>

  {#if header}
    <div class="shrink-0 px-[18px] pt-1.5 pb-2 pointer-fine:[.is-laptop-display_&]:px-[14px]">
      {@render header()}
    </div>
  {/if}

  <div
    class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-[14px] [-webkit-overflow-scrolling:touch] pointer-fine:[.is-laptop-display_&]:px-3 {header
      ? ''
      : 'pt-1.5'} {footer ? '' : 'pb-[max(1rem,env(safe-area-inset-bottom,0px))]'}"
  >
    {@render children()}
  </div>

  {#if footer}
    <div
      class="shrink-0 px-[14px] pt-3 pb-[max(1rem,env(safe-area-inset-bottom,0px))] pointer-fine:[.is-laptop-display_&]:px-3"
    >
      {@render footer()}
    </div>
  {/if}
</div>

<style>
  /* An iOS sheet arrives from the edge it is anchored to. Transform only, so it
     never repaints the page behind it while it travels. */
  .bottom-sheet {
    animation: bottom-sheet-rise 0.28s cubic-bezier(0.32, 0.72, 0, 1);
  }

  @keyframes bottom-sheet-rise {
    from {
      transform: translateY(100%);
    }
    to {
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .bottom-sheet {
      animation: none;
    }
  }
</style>
