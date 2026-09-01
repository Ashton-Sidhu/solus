<script lang="ts">
  import type { Snippet } from "svelte";
  import { ArrowRightToLine as ArrowLineRightIcon, ChevronRight as CaretRightIcon } from "@lucide/svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import * as Card from "../ui/card";

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  interface Props {
    /** One word naming the payload type — Session, Plan, Document, Image. It is
     *  the only thing that names the type, which is what frees the chip to carry
     *  state and the header to carry no colour at all. */
    kicker: string;
    title: string;
    subtitle?: string;
    actionLabel?: string;
    ariaLabel?: string;
    skipMotion?: boolean;
    class?: string;
    "data-testid"?: string;
    /** When true, the card toggles its own body (caret affordance) instead of
     *  showing an "Open" button, and the body only renders while `expanded`. */
    expandable?: boolean;
    expanded?: boolean;
    onOpen: () => void;
    onOpenSecondary?: () => void;
    secondaryActionLabel?: string;
    actions?: Snippet;
    /** Status chip beside the title. */
    chip?: Snippet;
    /** Rich second line under the title; replaces `subtitle` when present. */
    statusSlot?: Snippet;
    children?: Snippet;
    /** Action rail along the bottom; the card draws no rail without one. */
    footer?: Snippet;
    /** A picture, not prose: the body fills the card edge to edge and skips the
     *  three-lines-then-fade treatment that text bodies get. */
    bleedBody?: boolean;
  }

  let {
    kicker,
    title,
    subtitle,
    actionLabel = "Open",
    ariaLabel,
    skipMotion = false,
    class: extraClass = "",
    "data-testid": dataTestId,
    expandable = false,
    expanded = false,
    onOpen,
    onOpenSecondary,
    secondaryActionLabel = "Open in side pane",
    actions,
    chip,
    statusSlot,
    children,
    footer,
    bleedBody = false,
  }: Props = $props();

  function isNestedInteractive(
    target: EventTarget | null,
    root: EventTarget | null,
  ): boolean {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest(
      "a, button, input, textarea, select, [role='button']",
    );
    return !!interactive && interactive !== root;
  }

  function handleClick(e: MouseEvent) {
    if (isNestedInteractive(e.target, e.currentTarget)) return;
    // Cmd-click opens into the pane — the same thing the split button does.
    if ((e.metaKey || e.ctrlKey) && onOpenSecondary) {
      onOpenSecondary();
      return;
    }
    onOpen();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpen();
  }
</script>

<div class="py-2 {skipMotion ? '' : 'animate-msg-in-side'}">
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <Card.Root
    class="conversation-ref-card group mx-auto w-[88%] gap-0 rounded-2xl py-0 shadow-none {extraClass}"
    data-testid={dataTestId}
    onclick={handleClick}
    role="button"
    tabindex={0}
    aria-label={ariaLabel ?? title}
    aria-expanded={expandable ? expanded : undefined}
    onkeydown={handleKeydown}
  >
    <!-- No icon tile and no header wash: the header sits on the card surface and
         is separated from the body by a 6% hairline alone. -->
    <div class="conversation-ref-card__header flex items-center gap-3">
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="conversation-ref-card__kicker">{kicker}</span>
        <span class="flex min-w-0 items-center gap-2">
          <span class="conversation-ref-card__title min-w-0 truncate">
            {title}
          </span>
          {#if chip}
            {@render chip()}
          {/if}
        </span>
        {#if statusSlot}
          {@render statusSlot()}
        {:else if subtitle}
          <span class="conversation-ref-card__subtitle truncate">
            {subtitle}
          </span>
        {/if}
      </span>
      <!-- Always present, never hover-only: the split affordance has to be
           discoverable on a static card, including one whose primary is a
           toggle. -->
      {#if onOpenSecondary}
        <button
          type="button"
          class="conversation-ref-card__secondary-action shrink-0 cursor-pointer"
          title={secondaryActionLabel}
          aria-label={secondaryActionLabel}
          onclick={(e) => {
            e.stopPropagation();
            onOpenSecondary();
          }}
        >
          <ArrowLineRightIcon size={14} />
        </button>
      {/if}
      {#if actions}
        {@render actions()}
      {:else if expandable}
        <CaretRightIcon
          size={14}
          weight="bold"
          aria-hidden="true"
          class="conversation-ref-card__caret mr-1.5 shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 ease-(--ease-premium) group-hover:text-(--solus-text-secondary) {expanded
            ? 'rotate-90'
            : ''}"
        />
      {:else}
        <button
          type="button"
          class="conversation-ref-card__action shrink-0 cursor-pointer"
          onclick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {actionLabel}
        </button>
      {/if}
    </div>
    {#if children}
      {#if expandable}
        {@render children()}
      {/if}
    {/if}
    {#if footer}
      <div class="conversation-ref-card__rail flex items-center gap-1">
        {@render footer()}
      </div>
    {/if}
  </Card.Root>
</div>

<style>
  :global(.conversation-ref-card) {
    background: var(--solus-tx-card-bg);
    /* The edge is a ring inside the shadow, not a border: it keeps the card's
       box the same width as the flush cards beside it. */
    border: none;
    box-shadow: var(--solus-tx-card-shadow);
    cursor: pointer;
    overflow: hidden;
    transition:
      transform var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium);
  }

  /* A card that opens something answers the pointer by rising, not by washing:
     the fill stays paper so the body text underneath never shifts value. */
  :global(.conversation-ref-card):hover {
    box-shadow: var(--solus-tx-card-shadow-hover);
    transform: translateY(-0.0625rem);
  }

  :global(.conversation-ref-card):active {
    transform: scale(0.996);
  }

  :global(.conversation-ref-card):focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.1875rem;
  }

  .conversation-ref-card__header {
    padding: 0.9375rem 1.0625rem 0.8125rem;
  }

  /* Geometry only: the type rungs already follow the display, and touch keeps
     the open spacing. */
  @media (pointer: fine) {
    :global(html.is-laptop-display) .conversation-ref-card__header {
      padding: 0.6875rem 0.875rem 0.625rem;
    }
  }

  .conversation-ref-card__kicker {
    margin-bottom: 0.3125rem;
    font-size: var(--text-transcript-meta);
    font-weight: 500;

    text-transform: uppercase;
    color: var(--muted-foreground);
    opacity: 0.7;
  }

  .conversation-ref-card__title {
    font-size: var(--text-transcript-card);
    font-weight: 500;
    color: var(--solus-text-primary);
  }

  .conversation-ref-card__subtitle {
    margin-top: 0.125rem;
    font-size: var(--text-transcript-meta);
    color: var(--muted-foreground);
    text-wrap: pretty;
  }

  .conversation-ref-card__action,
  .conversation-ref-card__secondary-action {
    height: 1.75rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    padding: 0 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-transcript-meta);
    font-weight: 500;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }

  .conversation-ref-card__action {
    background: color-mix(in oklch, var(--foreground) 6%, transparent);
  }

  .conversation-ref-card__secondary-action {
    display: inline-flex;
    width: 1.75rem;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .conversation-ref-card__secondary-action:hover {
    background: color-mix(in oklch, var(--foreground) 7%, transparent);
    color: var(--solus-text-primary);
  }

  .conversation-ref-card__action:hover {
    background: color-mix(in oklch, var(--foreground) 11%, transparent);
    color: var(--solus-text-primary);
  }

  .conversation-ref-card__action:active,
  .conversation-ref-card__secondary-action:active {
    transform: scale(0.96);
  }

  .conversation-ref-card__action:focus-visible,
  .conversation-ref-card__secondary-action:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  .conversation-ref-card__rail {
    padding: 0.5rem 0.625rem;
    border-top: 0.0625rem solid var(--solus-tx-rule);
  }
</style>
