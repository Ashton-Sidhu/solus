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
>
  {#snippet loadingIcon()}
    <Loader2Icon class="size-4 animate-spin" />
  {/snippet}
  {#snippet successIcon()}
    <!-- Same green a completed run wears elsewhere, in both themes. -->
    <CircleCheckIcon class="size-4 text-(--solus-status-complete)" />
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

  /* Sonner only spins its loader on "loading" toasts, and those lose the close
     button, so a running Solus operation draws its own spinner in the icon
     gutter. Sonner already owns the toast's ::before and ::after. */
  :global(.toaster [data-sonner-toast].solus-toast-progress) {
    padding-left: 2.5rem;
  }

  :global(.toaster [data-sonner-toast].solus-toast-progress [data-content]::before) {
    content: "";
    position: absolute;
    left: 1rem;
    top: 0;
    bottom: 0;
    margin-block: auto;
    height: 1rem;
    width: 1rem;
    border: 2px solid var(--color-border);
    border-top-color: var(--color-muted-foreground);
    border-radius: 9999px;
    animation: solus-toast-spin 0.7s linear infinite;
  }

  @keyframes solus-toast-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.toaster [data-sonner-toast].solus-toast-progress [data-content]::before) {
      animation: none;
    }
  }

  /* Sonner parks the close button on the leading edge, which collides with the
     status icon. Move it to the trailing corner and use Solus surface tokens. */
  :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button]) {
    left: unset;
    right: 0;
    transform: translate(35%, -35%);
    background: var(--color-popover);
    border-color: var(--color-border);
    color: var(--color-muted-foreground);
  }

  :global(.toaster [data-sonner-toast][data-styled="true"]:hover [data-close-button]:hover) {
    background: var(--color-accent);
    border-color: var(--color-border);
    color: var(--color-popover-foreground);
  }

</style>
