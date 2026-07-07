<script lang="ts">
  import type { Snippet } from "svelte";
  import { ArrowLineRightIcon, CaretRightIcon } from "phosphor-svelte";
  import { slide } from "svelte/transition";
  import { cubicOut } from "svelte/easing";

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  interface Props {
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
    icon: Snippet;
    actions?: Snippet;
    /** Rich second line under the title; replaces `subtitle` when present. */
    statusSlot?: Snippet;
    children?: Snippet;
  }

  let {
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
    icon,
    actions,
    statusSlot,
    children,
  }: Props = $props();

  function isNestedInteractive(target: EventTarget | null, root: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest("a, button, input, textarea, select, [role='button']");
    return !!interactive && interactive !== root;
  }

  function handleClick(e: MouseEvent) {
    if (isNestedInteractive(e.target, e.currentTarget)) return;
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
  <div
    class="conversation-ref-card group mx-auto w-4/5 rounded-lg {extraClass}"
    data-testid={dataTestId}
    onclick={handleClick}
    role="button"
    tabindex="0"
    aria-label={ariaLabel ?? title}
    aria-expanded={expandable ? expanded : undefined}
    onkeydown={handleKeydown}
  >
    <div class="conversation-ref-card__header flex items-center gap-3">
      <span
        class="conversation-ref-card__icon inline-flex shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        {@render icon()}
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="conversation-ref-card__title min-w-0 truncate text-sm font-semibold text-(--solus-text-primary)">
          {title}
        </span>
        {#if statusSlot}
          {@render statusSlot()}
        {:else if subtitle}
          <span class="conversation-ref-card__subtitle truncate text-xs text-(--solus-text-tertiary)">
            {subtitle}
          </span>
        {/if}
      </span>
      {#if actions}
        {@render actions()}
      {:else if expandable}
        <CaretRightIcon
          size={14}
          weight="bold"
          aria-hidden="true"
          class="conversation-ref-card__caret shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 ease-(--ease-premium) group-hover:text-(--solus-text-secondary) {expanded ? 'rotate-90' : ''}"
        />
      {:else}
        <span class="conversation-ref-card__actions">
          {#if onOpenSecondary}
            <button
              type="button"
              class="conversation-ref-card__secondary-action cursor-pointer"
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
        </span>
      {/if}
    </div>
    {#if children}
      {#if expandable}
        {#if expanded}
          <div
            class="conversation-ref-card__body"
            transition:slide={{ duration: reduceMotion ? 0 : 180, easing: cubicOut }}
          >
            {@render children()}
          </div>
        {/if}
      {:else}
        <div class="conversation-ref-card__body">
          {@render children()}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .conversation-ref-card {
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--solus-container-bg) 96%, var(--solus-surface-primary)),
        var(--solus-container-bg)
      );
    cursor: pointer;
    overflow: hidden;
    box-shadow:
      0 0 0 0.0625rem color-mix(in srgb, var(--solus-tool-border) 72%, transparent),
      0 0.0625rem 0.125rem color-mix(in srgb, black 5%, transparent),
      0 0.625rem 1.75rem -1.5rem color-mix(in srgb, black 28%, transparent);
    transition:
      box-shadow var(--duration-base) var(--ease-premium),
      transform var(--duration-quick) var(--ease-premium),
      background var(--duration-base) var(--ease-premium);
  }

  .conversation-ref-card:hover {
    box-shadow:
      0 0 0 0.0625rem color-mix(in srgb, var(--solus-accent-border) 68%, var(--solus-tool-border)),
      0 0.125rem 0.375rem color-mix(in srgb, black 7%, transparent),
      0 0.875rem 2.25rem -1.625rem color-mix(in srgb, black 34%, transparent);
  }

  .conversation-ref-card:active {
    transform: scale(0.996);
  }

  .conversation-ref-card:focus-visible {
    outline: 0.125rem solid var(--solus-accent-border-medium);
    outline-offset: 0.1875rem;
  }

  .conversation-ref-card__header {
    padding: 0.75rem;
  }

  .conversation-ref-card__icon {
    width: 2rem;
    height: 2rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--solus-accent-light) 72%, transparent);
    box-shadow: inset 0 0 0 0.0625rem color-mix(in srgb, var(--solus-accent-border) 42%, transparent);
  }

  .conversation-ref-card__title {
    letter-spacing: 0;
    text-wrap: balance;
  }

  .conversation-ref-card__subtitle {
    text-wrap: pretty;
  }

  .conversation-ref-card__actions {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
  }

  .conversation-ref-card__action,
  .conversation-ref-card__secondary-action {
    min-width: 2.5rem;
    height: 2rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    padding: 0 0.625rem;
    color: var(--solus-text-tertiary);
    font-size: 0.75rem;
    font-weight: 550;
    transition:
      background var(--duration-quick) var(--ease-premium),
      color var(--duration-quick) var(--ease-premium),
      opacity var(--duration-quick) var(--ease-premium),
      transform 80ms var(--ease-premium);
  }

  .conversation-ref-card__secondary-action {
    display: inline-flex;
    min-width: 2rem;
    align-items: center;
    justify-content: center;
    padding: 0;
  }

  .conversation-ref-card:hover .conversation-ref-card__action,
  .conversation-ref-card:hover .conversation-ref-card__secondary-action,
  .conversation-ref-card:focus-within .conversation-ref-card__secondary-action,
  .conversation-ref-card:focus-within .conversation-ref-card__action {
    color: var(--solus-text-secondary);
  }

  .conversation-ref-card__action:hover,
  .conversation-ref-card__secondary-action:hover {
    background: var(--solus-surface-hover);
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

  .conversation-ref-card__caret {
    margin-right: 0.375rem;
  }

  .conversation-ref-card__body {
    box-shadow: inset 0 0.0625rem 0 color-mix(in srgb, var(--solus-tool-border) 72%, transparent);
    background:
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--solus-code-tint) 54%, transparent),
        color-mix(in srgb, var(--solus-container-bg) 88%, var(--solus-code-tint))
      );
  }

  @media (hover: hover) and (pointer: fine) {
    .conversation-ref-card__action {
      opacity: 0.64;
    }

    .conversation-ref-card__secondary-action {
      opacity: 0;
    }

    .conversation-ref-card:hover .conversation-ref-card__action,
    .conversation-ref-card:hover .conversation-ref-card__secondary-action,
    .conversation-ref-card:focus-within .conversation-ref-card__action,
    .conversation-ref-card:focus-within .conversation-ref-card__secondary-action {
      opacity: 1;
    }
  }
</style>
