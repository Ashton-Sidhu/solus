<script lang="ts">
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import InfoIcon from "@lucide/svelte/icons/info";
  import Loader2Icon from "@lucide/svelte/icons/loader-2";
  import OctagonXIcon from "@lucide/svelte/icons/octagon-x";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import {
    Toaster as Sonner,
    type ToasterProps as SonnerProps,
  } from "svelte-sonner";

  let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
  theme="system"
  class="toaster group"
  style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
  {...restProps}
  closeButton
>
  {#snippet loadingIcon()}
    <Loader2Icon class="size-4 animate-spin" />
  {/snippet}
  {#snippet successIcon()}
    <CircleCheckIcon class="size-4" />
  {/snippet}
  {#snippet errorIcon()}
    <OctagonXIcon class="size-4" />
  {/snippet}
  {#snippet infoIcon()}
    <InfoIcon class="size-4" />
  {/snippet}
  {#snippet warningIcon()}
    <TriangleAlertIcon class="size-4" />
  {/snippet}
</Sonner>

<style>
  /* Sonner's action buttons never shrink, so a long message beside them
     squeezes to one word per line and then breaks mid-word. Give the content
     the leftover row width instead: text wraps at word boundaries while the
     icon and buttons keep Sonner's stock single-row shadcn layout. */
  :global(.toaster [data-sonner-toast][data-styled="true"] [data-content]) {
    flex: 1 1 0%;
    min-width: 0;
    overflow-wrap: break-word;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-title]) {
    text-wrap: balance;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-description]) {
    text-wrap: pretty;
  }

  /* Sonner starts swipe handling when pointerdown targets the close SVG rather
     than its button. Keep the button as the event target, and extend its small
     stock control outward so it has a reliable 40px hit area without covering
     toast content. */
  :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button] > svg) {
    pointer-events: none;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button]::before) {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 40px;
    height: 40px;
    content: "";
  }

  :global(.toaster[dir="rtl"] [data-sonner-toast][data-styled="true"] [data-close-button]::before) {
    right: auto;
    left: 0;
  }
</style>
