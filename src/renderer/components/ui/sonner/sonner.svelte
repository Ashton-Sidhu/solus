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
  /* Sonner lays a toast out as one flex row whose action buttons never shrink,
     so a long message next to two buttons collapses to one word per line (and
     `overflow-wrap: anywhere` then breaks mid-word). Let the row wrap instead:
     the message keeps the full width and the buttons drop to their own line,
     right-aligned. Short message + single action still fits on one line. */
  :global(.toaster [data-sonner-toast][data-styled="true"]) {
    padding-right: 44px;
    flex-wrap: wrap;
    row-gap: 10px;
    overflow-wrap: break-word;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-content]) {
    flex: 1 1 auto;
    min-width: 0;
  }

  :global(
    .toaster [data-sonner-toast][data-styled="true"] [data-button]:first-of-type
  ) {
    margin-left: auto;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button]) {
    top: 8px;
    right: 8px;
    left: auto;
    transform: none;
  }
</style>
