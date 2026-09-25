<script lang="ts">
  import type { Snippet } from "svelte";
  import {
    ChevronDown as CaretDownIcon,
    Ellipsis as EllipsisIcon,
    PanelRight as PanelRightIcon,
  } from "@lucide/svelte";
  import { mergeProps } from "bits-ui";
  import * as Popover from "../ui/popover";
  import { requestInputFocus } from "../../lib/inputFocus";
  import { isNestedInteractive } from "./lib/transcript-card";
  import TranscriptCardAction from "./TranscriptCardAction.svelte";

  /**
   * The one shell every transcript card uses (docs/transcript-cards.md).
   * A card is a single 40px line at full column width, with the same slots as
   * `ActivityRow`: glyph, title, type word, target, rail, then actions. A body
   * appears only when there is something to read.
   *
   * Quiet cards sit one step above the page. Only a card that blocks the turn
   * until the user acts takes the `attention` variant.
   */
  interface Props {
    title: string;
    /** Lowercase, one or two words: `plan`, `doc`, `returned`. Never truncates. */
    type?: string;
    /** Optional path, branch, or file, in mono. */
    target?: string;
    variant?: "quiet" | "attention";
    /** The card's object is open in the companion pane. */
    open?: boolean;
    failed?: boolean;
    /** An agent is waiting on the user. */
    waiting?: boolean;
    /** An earlier version or a closed session. */
    superseded?: boolean;
    /** A disclosure card: the caret shows and the body renders only when true. */
    expanded?: boolean;
    /** Primary button that runs `onOpen`. */
    actionLabel?: string;
    /** Fill the primary button: the card is waiting on the user. */
    actionFilled?: boolean;
    ariaLabel?: string;
    secondaryActionLabel?: string;
    /** Tint for the glyph slot: `is-done`, `is-failed`, or `is-artifact`. */
    glyphClass?: string;
    /** Body layout: indented prose, full-bleed media, or grouped rows. */
    bodyLayout?: "prose" | "media" | "rows";
    skipMotion?: boolean;
    class?: string;
    "data-testid"?: string;
    onOpen?: () => void;
    onOpenSecondary?: () => void;
    glyph?: Snippet;
    /** Counts and time only, never prose. */
    rail?: Snippet;
    /** Actions follow the body, or sit at the right edge of a header-only card. */
    actions?: Snippet;
    /** Everything else, behind ⋯. */
    menu?: Snippet;
    body?: Snippet;
    /** The progress seam along the bottom edge. */
    seam?: Snippet;
  }

  let {
    title,
    type,
    target,
    variant = "quiet",
    open = false,
    failed = false,
    waiting = false,
    superseded = false,
    expanded,
    actionLabel,
    actionFilled = false,
    ariaLabel,
    secondaryActionLabel = "Open in side pane",
    glyphClass = "",
    bodyLayout = "prose",
    skipMotion = false,
    class: extraClass = "",
    "data-testid": dataTestId,
    onOpen,
    onOpenSecondary,
    glyph,
    rail,
    actions,
    menu,
    body,
    seam,
  }: Props = $props();

  let menuOpen = $state(false);
  const isClickable = $derived(!!onOpen);
  const isDisclosure = $derived(expanded !== undefined);
  const showBody = $derived(!!body && expanded !== false);
  const endsInButton = $derived(
    !!(actionLabel || menu || onOpenSecondary || actions || isDisclosure),
  );

  function handleClick(e: MouseEvent) {
    if (!onOpen || isNestedInteractive(e.target, e.currentTarget)) return;
    // Cmd-click opens into the pane, the same as the split icon.
    if ((e.metaKey || e.ctrlKey) && onOpenSecondary) {
      onOpenSecondary();
      return;
    }
    onOpen();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!onOpen || isNestedInteractive(e.target, e.currentTarget)) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onOpen();
  }

  function handleMenuCloseAutoFocus(event: Event) {
    event.preventDefault();
    requestInputFocus();
  }
</script>

<div class="py-1 {skipMotion ? '' : 'animate-msg-in-side'}">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="tx-card {extraClass}"
    class:is-clickable={isClickable}
    class:is-attention={variant === "attention"}
    class:is-open={open}
    class:is-failed={failed}
    class:is-waiting={waiting}
    class:is-superseded={superseded}
    data-testid={dataTestId}
    role={isClickable ? "button" : undefined}
    tabindex={isClickable ? 0 : undefined}
    aria-label={isClickable ? (ariaLabel ?? title) : undefined}
    aria-expanded={isClickable && isDisclosure ? expanded : undefined}
    onclick={handleClick}
    onkeydown={handleKeydown}
  >
    <div class="tx-card__head" class:ends-in-button={endsInButton}>
      {#if glyph}
        <span class="tx-card__glyph {glyphClass}">{@render glyph()}</span>
      {/if}
      <span class="tx-card__title truncate">{title}</span>
      {#if type}
        <span class="tx-card__type">{type}</span>
      {/if}
      {#if target}
        <span class="tx-card__target min-w-0 truncate">{target}</span>
      {/if}
      <span class="flex-1"></span>
      {#if rail}
        <span class="tx-card__rail">{@render rail()}</span>
      {/if}
      {#if !showBody}{@render cardActions()}{/if}
      {#if isDisclosure}
        <span class="tx-card-action is-icon" aria-hidden="true">
          <CaretDownIcon
            size={13}
            class="transition-transform duration-150 ease-(--ease-premium) {expanded
              ? ''
              : '-rotate-90'}"
          />
        </span>
      {/if}
    </div>
    {#if showBody && body}
      <div
        class="tx-card__body"
        class:is-prose={bodyLayout === "prose"}
        class:is-media={bodyLayout === "media"}
        class:is-rows={bodyLayout === "rows"}
      >
        {@render body()}
      </div>
    {/if}
    {#if showBody && (actions || onOpenSecondary || actionLabel || menu)}
      <div class="flex flex-wrap items-center justify-end gap-1 px-(--tx-card-pad-r) pb-2">
        {@render cardActions()}
      </div>
    {/if}
    {#if seam}
      <div class="tx-card__seam" aria-hidden="true">{@render seam()}</div>
    {/if}
  </div>
</div>

{#snippet cardActions()}
  {#if actions || onOpenSecondary || actionLabel || menu}
    <div class="flex min-w-0 flex-wrap items-center justify-end gap-1">
      {#if actions}{@render actions()}{/if}
      <!-- Always visible, never hover-only: the split has to be found on a
           static card too. -->
      {#if onOpenSecondary}
        <TranscriptCardAction
          kind="icon"
          label={secondaryActionLabel}
          onclick={onOpenSecondary}
        >
          <PanelRightIcon size={13} />
        </TranscriptCardAction>
      {/if}
      {#if menu}
        <Popover.Root bind:open={menuOpen}>
          <Popover.Trigger>
            {#snippet child({ props })}
              <button
                {...mergeProps(props, {
                  onclick: (e: MouseEvent) => e.stopPropagation(),
                })}
                type="button"
                class="tx-card-action is-icon"
                aria-label="More actions"
                title="More actions"
              >
                <EllipsisIcon size={13} />
              </button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content
            align="end"
            sideOffset={6}
            class="w-auto min-w-44 gap-0.5 p-1"
            onCloseAutoFocus={handleMenuCloseAutoFocus}
          >
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="flex flex-col gap-0.5" onclick={(e) => e.stopPropagation()}>
              {@render menu()}
            </div>
          </Popover.Content>
        </Popover.Root>
      {/if}
      {#if actionLabel && onOpen}
        <TranscriptCardAction
          kind={actionFilled ? "filled" : "primary"}
          onclick={onOpen}>{actionLabel}</TranscriptCardAction
        >
      {/if}
    </div>
  {/if}
{/snippet}

<style>
  .tx-card {
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--tx-card-radius);
    background: var(--solus-tx-card-bg);
    box-shadow: var(--solus-tx-quiet-shadow);
    transition:
      transform var(--duration-quick) var(--ease-premium),
      box-shadow var(--duration-quick) var(--ease-premium),
      opacity var(--duration-quick) var(--ease-premium);
  }

  .tx-card.is-clickable {
    cursor: pointer;
  }

  /* A card answers the pointer with its ring, not by moving or washing. */
  .tx-card.is-clickable:not(.is-open):hover:not(:has(:is(a, button, input, textarea, select, [role="button"]):hover)) {
    box-shadow: var(--solus-tx-quiet-shadow-hover);
  }

  /* :active also matches the ancestors of a pressed button. Keep the card still
     when one of its controls is pressed, as handleClick ignores it. */
  .tx-card.is-clickable:active:not(:has(:is(a, button, input, textarea, select, [role="button"]):active)) {
    transform: scale(0.996);
  }

  .tx-card:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.125rem;
  }

  .tx-card.is-attention {
    box-shadow: var(--solus-tx-attention-shadow);
  }

  .tx-card.is-failed {
    box-shadow:
      0 0 0 0.03125rem color-mix(in oklch, var(--destructive) 26%, transparent),
      0 0.0625rem 0.125rem rgba(60, 45, 30, 0.04);
  }

  .tx-card.is-waiting {
    box-shadow:
      inset 0 0 0 0.0625rem color-mix(in oklch, var(--chart-2) 40%, transparent),
      var(--solus-tx-quiet-shadow);
  }

  /* Open in the pane: the same accent ring the composer takes on focus. */
  .tx-card.is-open {
    box-shadow:
      0 0 0 0.0625rem color-mix(in oklch, var(--solus-accent) 34%, transparent),
      0 0 0 0.25rem color-mix(in oklch, var(--solus-accent) 9%, transparent);
  }

  .tx-card.is-superseded {
    opacity: 0.85;
  }

  .tx-card.is-superseded:hover {
    opacity: 1;
  }

  .tx-card__head {
    display: flex;
    min-width: 0;
    height: var(--tx-card-head);
    flex-shrink: 0;
    align-items: center;
    gap: var(--tx-card-gap);
    padding: 0 var(--tx-card-pad-l);
  }

  .tx-card__head.ends-in-button {
    padding-right: var(--tx-card-pad-r);
  }

  /* The same 22px slot as .activity-glyph, so cards and rows line up. */
  .tx-card__glyph {
    /* Sizes the shared .activity-spinner. */
    --activity-icon-size: 0.75rem;
    display: inline-flex;
    min-width: var(--tx-card-glyph);
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
  }

  .tx-card__glyph :global(svg) {
    width: 0.8125rem;
    height: 0.8125rem;
  }

  :global(.tx-card__glyph.is-done) {
    color: color-mix(in oklch, var(--chart-3) 70%, var(--foreground));
  }

  :global(.tx-card__glyph.is-failed) {
    color: color-mix(in oklch, var(--destructive) 70%, var(--foreground));
  }

  :global(.tx-card__glyph.is-artifact) {
    color: var(--primary);
  }

  .tx-card__title {
    min-width: 0;
    font-size: var(--text-activity-label);
    font-weight: 500;
    color: var(--solus-text-primary);
  }

  .tx-card__type {
    flex-shrink: 0;
    white-space: nowrap;
    font-size: var(--text-activity-label);
    color: var(--muted-foreground);
  }

  .tx-card__target {
    font-size: var(--text-tool-step);
    color: var(--muted-foreground);
  }

  .tx-card__rail {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
    font-size: var(--text-transcript-meta);
    font-variant-numeric: tabular-nums;
    color: color-mix(in oklch, var(--muted-foreground) 70%, transparent);
  }

  /* A prose body opens without a rule, indented to the title. */
  .tx-card__body.is-prose {
    padding: 0.125rem var(--tx-card-pad-l) 0.75rem var(--tx-card-body-indent);
    font-size: var(--text-activity-label);
    line-height: 1.55;
    color: var(--solus-text-primary);
  }

  /* Media bleeds edge to edge under a full-width rule, capped at 150px. */
  .tx-card__body.is-media {
    max-height: 9.375rem;
    overflow: hidden;
    border-top: 0.03125rem solid var(--solus-tx-divider);
  }

  .tx-card__body.is-rows {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    padding: 0.25rem;
  }

  /* The rule above a row list is inset 12px on both sides. */
  .tx-card__body.is-rows::before {
    content: "";
    height: 0.03125rem;
    margin: -0.25rem var(--tx-card-pad-l) 0.1875rem;
    background: var(--solus-tx-divider);
  }

  .tx-card__seam {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    height: 0.125rem;
    gap: 0.0625rem;
  }
</style>
