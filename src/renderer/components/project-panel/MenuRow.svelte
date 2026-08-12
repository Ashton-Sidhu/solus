<script lang="ts" module>
  import { XIcon } from "phosphor-svelte";

  export type ActionRowPhase = "idle" | "loading" | "success" | "error";
  export type ActionRowIcon = typeof XIcon;

  /** One row in a project-panel action list — every card renders the same language. */
  export interface ActionRowItem {
    key: string;
    label: string;
    icon: ActionRowIcon;
    phase: ActionRowPhase;
    danger?: boolean;
    disabled?: boolean;
    /** Quiet tabular metric or qualifier in the trailing slot ("28", "Ghostty"). */
    badge?: string;
    /** Tints the glyph alone, for a state the row *reports* (a PR's checks are
     *  failing) rather than what activating it does — recolouring the label too
     *  would read as the action itself being destructive. */
    iconTone?: "success" | "running" | "danger";
    /** Keyboard hint, set in mono after the badge ("⌥⇧D"). */
    hint?: string;
    tooltip?: string;
    /** Set when the row opens a menu instead of running: the row trades its key
     *  hint for a caret and the click toggles the popover of that name. */
    disclosure?: string;
  }
</script>

<script lang="ts">
  import { CaretRightIcon, CheckIcon, SpinnerGapIcon } from "phosphor-svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";

  interface Props {
    item: ActionRowItem;
    /** Primary half of a split row: stretches so the caret can sit beside it. */
    split?: boolean;
    /** Whether this disclosure row's menu is currently open. */
    menuOpen?: boolean;
    onActivate: (
      event: MouseEvent & { currentTarget: HTMLButtonElement },
    ) => void;
  }
  let { item, split = false, menuOpen = false, onActivate }: Props = $props();
</script>

<TooltipUI.Root>
  <TooltipUI.Trigger>
    {#snippet child({ props: tooltipProps })}
      <button
        {...tooltipProps}
        type="button"
        class="menu-row"
        class:split-primary={split}
        class:is-danger={item.danger}
        class:is-success={item.phase === "success"}
        class:is-error={item.phase === "error"}
        class:is-loading={item.phase === "loading"}
        class:is-open={!!item.disclosure && menuOpen}
        disabled={item.disabled}
        aria-haspopup={item.disclosure ? "menu" : undefined}
        aria-expanded={item.disclosure ? menuOpen : undefined}
        onclick={onActivate}
      >
        <span class="menu-left">
          <span class="menu-icon" data-tone={item.iconTone}>
            {#if item.phase === "loading"}
              <span class="glyph-spin"><SpinnerGapIcon size={13} /></span>
            {:else if item.phase === "success"}
              <span class="glyph-pop"><CheckIcon size={13} weight="bold" /></span>
            {:else}
              {@const Icon = item.icon}
              <Icon size={13} />
            {/if}
          </span>
          <span class="menu-label">{item.label}</span>
        </span>
        <span class="menu-right">
          {#if item.badge}<span class="menu-trail">{item.badge}</span>{/if}
          {#if item.hint && !item.disclosure}<span class="menu-hint"
              >{item.hint}</span
            >{/if}
          {#if item.disclosure}<span class="menu-caret"
              ><CaretRightIcon size={11} /></span
            >{/if}
        </span>
      </button>
    {/snippet}
  </TooltipUI.Trigger>
  <TooltipUI.Content value={item.tooltip ?? null} />
</TooltipUI.Root>

<style>
  /* ============================================================
     Menu language — mirrors the app's native menu rows:
     flat, borderless, accent-light hover, no fills, no scale.
     Quiet and premium.
     ============================================================ */
  .menu-row {
    width: 100%;
    min-height: 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.3125rem 0.5rem;
    border: none;
    border-radius: 0.4375rem;
    background: transparent;
    color: var(--solus-text-secondary);
    font-size: 0.8125rem;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease;
  }
  .menu-row.split-primary {
    flex: 1;
    min-width: 0;
  }
  .menu-row:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .menu-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 0.125rem
      color-mix(in srgb, var(--solus-accent) 35%, transparent);
  }
  .menu-row:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .menu-row.is-loading {
    opacity: 0.85;
  }
  .menu-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }
  .menu-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-text-secondary);
    transition: color 0.15s ease;
  }
  .menu-row:hover .menu-icon {
    color: var(--solus-text-primary);
  }
  /* A tone is a fact, so it survives hover — the hover rule above would
     otherwise wash it out exactly when the row is being read. */
  .menu-icon[data-tone="success"],
  .menu-row:hover .menu-icon[data-tone="success"] {
    color: var(--solus-status-complete);
  }
  .menu-icon[data-tone="running"],
  .menu-row:hover .menu-icon[data-tone="running"] {
    color: var(--solus-status-running);
  }
  .menu-icon[data-tone="danger"],
  .menu-row:hover .menu-icon[data-tone="danger"] {
    color: var(--solus-status-error);
  }
  .menu-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Trailing slot: the row's one metric, then its key hint. */
  .menu-right {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
    min-width: 0;
  }
  /* Regular weight: the row's one metric is quieter than its label, and the
     tabular figures already give it enough presence to scan down the column. */
  .menu-trail {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-size: 0.75rem;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  /* Disclosure caret closes the row. It points at where the menu opens — the
     menus flank the column rather than dropping into it. */
  .menu-caret {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    opacity: 0.55;
    transition: opacity 0.15s ease;
  }
  .menu-row:hover .menu-caret,
  .menu-row:focus-visible .menu-caret,
  .menu-row.is-open .menu-caret {
    opacity: 1;
  }
  /* An open row keeps the hover wash so it stays tied to its menu. */
  .menu-row.is-open {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }
  .menu-row.is-open .menu-icon {
    color: var(--solus-text-primary);
  }

  /* Key hints are mono and quieter than the metric, so the two never compete. */
  .menu-hint {
    flex-shrink: 0;
    color: var(--solus-text-tertiary);
    font-family: var(--solus-code-font-family);
    font-size: 0.75rem;
    opacity: 0.7;
  }

  .menu-row.is-danger,
  .menu-row.is-danger .menu-icon {
    color: var(--solus-status-error);
  }
  .menu-row.is-danger:hover {
    color: var(--solus-status-error);
    background: var(--solus-status-error-bg);
  }
  .menu-row.is-danger:hover .menu-icon {
    color: var(--solus-status-error);
  }

  .menu-row.is-success,
  .menu-row.is-success .menu-icon {
    color: var(--solus-status-complete);
  }

  /* Glyph state animations (kept subtle) */
  .glyph-spin,
  .glyph-pop {
    display: inline-flex;
  }
  @media (prefers-reduced-motion: no-preference) {
    .glyph-spin {
      animation: glyph-spin 0.7s linear infinite;
    }
    .glyph-pop {
      animation: glyph-pop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }
  @keyframes glyph-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes glyph-pop {
    0% {
      transform: scale(0.5);
      opacity: 0;
    }
    60% {
      transform: scale(1.15);
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .menu-row.is-error {
      animation: shake 0.34s cubic-bezier(0.36, 0.07, 0.19, 0.97);
    }
  }
  @keyframes shake {
    10%,
    90% {
      transform: translateX(-0.0625rem);
    }
    20%,
    80% {
      transform: translateX(0.125rem);
    }
    30%,
    50%,
    70% {
      transform: translateX(-0.125rem);
    }
    40%,
    60% {
      transform: translateX(0.125rem);
    }
  }
</style>
