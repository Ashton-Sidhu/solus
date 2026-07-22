<script lang="ts">
  import { cubicOut } from "svelte/easing";
  import { prefersReducedMotion } from "svelte/motion";
  import { fly } from "svelte/transition";
  import { XIcon } from "phosphor-svelte";
  import { toasts, type ToastAction } from "../lib/toast.store.svelte";

  const active = $derived(toasts.active);
  const transitionDuration = $derived(prefersReducedMotion.current ? 0 : 200);

  function handleAction(action: ToastAction) {
    toasts.dismiss();
    action.onAction();
  }
</script>

<div class="toast-region" data-solus-ui aria-live="polite">
  {#if active}
    <div
      class="toast toast--{active.kind}"
      role={active.kind === "error" ? "alert" : "status"}
      transition:fly={{ y: 8, duration: transitionDuration, easing: cubicOut }}
    >
      <span class="toast-marker" aria-hidden="true"></span>
      <p class="toast-message">{active.message}</p>
      {#if active.actions.length > 0}
        <div class="toast-actions">
          {#each active.actions as action}
            <button
              type="button"
              class="toast-action"
              onclick={() => handleAction(action)}
            >
              {action.label}
            </button>
          {/each}
        </div>
      {/if}
      <button
        type="button"
        class="toast-dismiss"
        aria-label="Dismiss notification"
        onclick={() => toasts.dismiss()}
      >
        <XIcon size={14} />
      </button>
    </div>
  {/if}
</div>

<style>
  .toast-region {
    position: fixed;
    z-index: 10030;
    right: max(1rem, env(safe-area-inset-right, 0px));
    bottom: max(1rem, env(safe-area-inset-bottom, 0px));
    left: max(1rem, env(safe-area-inset-left, 0px));
    display: flex;
    justify-content: center;
    pointer-events: none;
  }

  .toast {
    pointer-events: auto;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.5rem;
    width: fit-content;
    max-width: 30rem;
    padding: 0.5rem;
    padding-left: 0.875rem;
    border: 0.0625rem solid var(--solus-popover-border);
    border-radius: 0.875rem;
    background: var(--solus-popover-bg);
    box-shadow: var(--solus-popover-shadow);
    color: var(--solus-text-primary);
    backdrop-filter: blur(1.25rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.25rem) saturate(1.1);
  }

  .toast-marker {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: var(--solus-accent);
  }

  .toast--error .toast-marker {
    background: var(--solus-status-error);
  }

  .toast-message {
    min-width: 0;
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.35;
    text-wrap: pretty;
  }

  .toast-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .toast-action,
  .toast-dismiss {
    min-height: 2.5rem;
    border: none;
    background: transparent;
    color: var(--solus-text-secondary);
    cursor: pointer;
    transition:
      color 150ms ease-out,
      background-color 150ms ease-out,
      transform 150ms ease-out;
  }

  .toast-action {
    padding: 0 0.75rem;
    border-radius: 0.625rem;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .toast-dismiss {
    display: grid;
    width: 2.5rem;
    padding: 0;
    place-items: center;
    border-radius: 0.625rem;
  }

  .toast-action:hover,
  .toast-dismiss:hover {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .toast-action:active,
  .toast-dismiss:active {
    transform: scale(0.96);
  }

  .toast-action:focus-visible,
  .toast-dismiss:focus-visible {
    outline: 0.125rem solid var(--solus-accent);
    outline-offset: 0.0625rem;
  }

  @media (max-width: 30rem) {
    .toast {
      width: 100%;
      grid-template-columns: auto minmax(0, 1fr) auto;
    }

    .toast-actions {
      grid-column: 2 / -1;
      justify-self: start;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast-action,
    .toast-dismiss {
      transition: none;
    }

    .toast-action:active,
    .toast-dismiss:active {
      transform: none;
    }
  }
</style>
