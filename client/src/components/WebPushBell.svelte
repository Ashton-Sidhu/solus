<script lang="ts">
  import { BellIcon, BellSlashIcon, SpinnerIcon } from "phosphor-svelte";
  import * as TooltipUI from "@renderer/components/ui/tooltip";
  import { webPushState } from "../lib/web-push.svelte";
  import { toasts } from "@renderer/lib/toasts";
  import { getSettingsContext } from "@renderer/contexts";

  interface Props {
    variant?: "status" | "row";
  }
  let { variant = "status" }: Props = $props();
  const settings = getSettingsContext();

  const label = $derived(
    webPushState.subscribed ? "Disable notifications" : "Enable notifications",
  );

  async function toggle() {
    if (webPushState.permission === "denied") {
      toasts.error("Notifications are blocked in your browser settings");
      return;
    }

    try {
      await webPushState.toggle();
      settings.update({ soundEnabled: webPushState.subscribed });
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Notifications could not be updated");
    }
    if (webPushState.permission === "denied") {
      toasts.error("Notifications are blocked in your browser settings");
    }
  }
</script>

{#if webPushState.supported}
  {#if variant === "row"}
    <button
      type="button"
      class="flex w-full min-h-12 items-center gap-3.5 border-0 bg-transparent px-3.5 py-3 text-left cursor-pointer transition-colors duration-[120ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:bg-(--solus-accent-light) disabled:opacity-40 disabled:cursor-default disabled:active:bg-transparent [-webkit-tap-highlight-color:transparent]"
      onclick={toggle}
      disabled={webPushState.busy}
      aria-pressed={webPushState.subscribed}
    >
      <span class="flex w-5 shrink-0 items-center justify-center font-secondary text-(--solus-text-secondary)">
        {#if webPushState.busy}
          <SpinnerIcon size={14} class="animate-spin" />
        {:else if webPushState.subscribed}
          <BellIcon size={14} weight="fill" />
        {:else}
          <BellSlashIcon size={14} />
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate text-sm font-medium text-(--solus-text-primary)">
        Notifications
      </span>
      <span class="shrink-0 text-sm text-(--solus-text-tertiary)">
        {webPushState.subscribed ? "On" : "Off"}
      </span>
    </button>
  {:else}
    <TooltipUI.Root>
      <TooltipUI.Trigger>
        {#snippet child({ props: tooltipProps })}
          <button {...tooltipProps}
      type="button"
      class="ws-push-btn"
      class:ws-push-btn--active={webPushState.subscribed}
      onclick={toggle}
      disabled={webPushState.busy}
      aria-label={label}
      aria-pressed={webPushState.subscribed}
    >
      {#if webPushState.busy}
        <SpinnerIcon size={14} class="animate-spin" />
      {:else if webPushState.subscribed}
        <BellIcon size={14} weight="fill" />
      {:else}
        <BellSlashIcon size={14} />
      {/if}
    </button>
        {/snippet}
      </TooltipUI.Trigger>
      <TooltipUI.Content value={label} />
    </TooltipUI.Root>
  {/if}
{/if}

<style>
  .ws-push-btn {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border: none;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    padding: 0;
    transition:
      color 0.15s ease,
      background 0.15s ease,
      transform 0.12s ease;
  }

  .ws-push-btn:hover {
    color: var(--solus-text-primary);
    background: var(--solus-surface-hover);
  }

  .ws-push-btn:active {
    transform: scale(0.96);
  }

  .ws-push-btn:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .ws-push-btn--active {
    color: var(--solus-accent);
    background: var(--solus-accent-light);
  }
</style>
