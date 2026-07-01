<script lang="ts">
  import type { Snippet } from "svelte";
  import { CaretRightIcon } from "phosphor-svelte";
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
    class="conversation-ref-card group mx-auto w-4/5 rounded-xl border border-(--solus-tool-border) {extraClass}"
    data-testid={dataTestId}
    onclick={handleClick}
    role="button"
    tabindex="0"
    aria-label={ariaLabel ?? title}
    aria-expanded={expandable ? expanded : undefined}
    onkeydown={handleKeydown}
  >
    <div class="flex items-center gap-3 p-3">
      <span
        class="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-(--solus-accent-light)"
        aria-hidden="true"
      >
        {@render icon()}
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="min-w-0 truncate text-sm font-semibold text-(--solus-text-primary)">
          {title}
        </span>
        {#if statusSlot}
          {@render statusSlot()}
        {:else if subtitle}
          <span class="truncate text-xs text-(--solus-text-tertiary)">
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
          class="shrink-0 text-(--solus-text-tertiary) transition-transform duration-150 ease-(--ease-premium) group-hover:text-(--solus-text-secondary) {expanded ? 'rotate-90' : ''}"
        />
      {:else}
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-lg border border-(--solus-tool-border) bg-transparent px-3 py-1.5 text-xs font-medium text-(--solus-text-secondary) hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:outline-none focus-visible:shadow-[0_0_0_0.125rem_color-mix(in_srgb,var(--solus-accent)_35%,transparent)]"
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
    background: var(--solus-container-bg);
    cursor: pointer;
    overflow: hidden;
  }

  .conversation-ref-card:hover {
    border-color: var(--solus-accent-border);
  }

  .conversation-ref-card__body {
    border-top: 0.0625rem solid var(--solus-tool-border);
    background: var(--solus-code-tint);
  }
</style>
