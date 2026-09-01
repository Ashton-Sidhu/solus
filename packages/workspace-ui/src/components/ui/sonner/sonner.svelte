<script lang="ts">
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import InfoIcon from "@lucide/svelte/icons/info";
  import Loader2Icon from "@lucide/svelte/icons/loader-2";
  import CircleXIcon from "@lucide/svelte/icons/circle-x";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import {
    Toaster as Sonner,
    type ToasterProps as SonnerProps,
  } from "svelte-sonner";
  let { ...restProps }: SonnerProps = $props();
</script>

<Sonner
  theme="system"
  class="toaster group no-drag"
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
    <!-- Circle to match the success mark, in the same red an error wears
         elsewhere; the stock icon inherited body text and read as neutral. -->
    <CircleXIcon class="size-4 text-(--solus-status-error)" />
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
     icon and buttons keep Sonner's stock single-row shadcn layout.

     A backend error can contain a full command and hundreds of paths, so the
     content also carries the height cap that keeps the card inside the
     viewport; the description below truncates while the Copy action still
     exposes the complete message. The cap sits here and not on the card,
     because the card must not clip its own overhanging close button. */
  :global(.toaster [data-sonner-toast][data-styled="true"] [data-content]) {
    flex: 1 1 0%;
    min-width: 0;
    min-height: 0;
    overflow-wrap: break-word;
    max-height: calc(100dvh - 4rem);
    overflow: hidden;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-title]) {
    text-wrap: balance;
  }

  :global(.toaster [data-sonner-toast][data-styled="true"] [data-description]) {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
     status icon. Move it to the trailing corner and use Solus surface tokens.
     It overhangs the corner, so nothing above it may clip overflow. */
  :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button]) {
    left: unset;
    right: 0;
    transform: translate(35%, -35%);
    background: var(--color-popover);
    border-color: var(--color-border);
    color: var(--color-muted-foreground);
  }

  /* The mark itself stays small, but a dismiss should not need a precise aim.
     Grow only the hit target, past the corner the badge already overhangs. */
  :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button]::after) {
    content: "";
    position: absolute;
    inset: -8px;
    border-radius: 9999px;
  }

  /* A thumb needs the full 44px target. */
  @media (pointer: coarse) {
    :global(.toaster [data-sonner-toast][data-styled="true"] [data-close-button]::after) {
      inset: -12px;
    }
  }

  :global(.toaster [data-sonner-toast][data-styled="true"]:hover [data-close-button]:hover) {
    background: var(--color-accent);
    border-color: var(--color-border);
    color: var(--color-popover-foreground);
  }

  /* ─── Laptop geometry ───
     The toast text already steps down with --text-workspace-chrome, but Sonner's
     box is fixed pixels, so on a laptop the card kept desktop bulk around smaller
     copy. Step the geometry down with the type: 2px off the padding, the icon,
     the buttons, and the close mark, with the width scaled to match. Geometry
     only — the type rung stays where index.css sets it. Sonner writes --width
     inline on the toaster element, so that one declaration must be !important. */
  @media (pointer: fine) {
    :global(html.is-laptop-display .toaster) {
      --width: 328px !important;
    }

    :global(html.is-laptop-display .toaster [data-sonner-toast][data-styled="true"]) {
      padding: 14px;
      gap: 5px;
    }

    :global(html.is-laptop-display .toaster [data-sonner-toast][data-styled="true"] [data-icon]),
    :global(html.is-laptop-display .toaster [data-sonner-toast][data-styled="true"] [data-icon] svg) {
      height: 0.875rem;
      width: 0.875rem;
    }

    :global(html.is-laptop-display .toaster [data-sonner-toast][data-styled="true"] [data-button]) {
      height: 22px;
    }

    :global(html.is-laptop-display .toaster [data-sonner-toast][data-styled="true"] [data-close-button]) {
      height: 18px;
      width: 18px;
    }

    :global(html.is-laptop-display .toaster [data-sonner-toast].solus-toast-progress) {
      padding-left: 2.25rem;
    }

    :global(html.is-laptop-display .toaster [data-sonner-toast].solus-toast-progress [data-content]::before) {
      left: 0.875rem;
      height: 0.875rem;
      width: 0.875rem;
    }
  }
</style>
