<script lang="ts">
  import { useOverlayTransition } from "./lib/overlay-transition.svelte";
  import MobileSessionList from "./MobileSessionList.svelte";
  import { blurActiveTextInputOnMobile } from "@solus/workspace-ui/lib/inputFocus";
  import { swipeDismiss } from "../lib/swipe-dismiss";

  interface Props {
    open: boolean;
    onClose: () => void;
    onOpenServers: () => void;
  }
  let { open, onClose, onOpenServers }: Props = $props();

  let drawerEl: HTMLDivElement | undefined = $state();
  let backdropEl: HTMLDivElement | undefined = $state();
  const transition = useOverlayTransition({
    open: () => open,
    panel: () => drawerEl,
    backdrop: () => backdropEl,
    hiddenTransform: "translateX(-100%)",
    enterDuration: 200,
    backdropDuration: 160,
    onHidden: blurActiveTextInputOnMobile,
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }
</script>

{#if transition.mounted}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="drawer-backdrop"
    class:drawer-hidden={!transition.visible}
    onclick={onClose}
    onkeydown={handleKeydown}
  ></div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={drawerEl}
    class="drawer-panel"
    class:drawer-hidden={!transition.visible}
    use:swipeDismiss={{
      axis: "x",
      sign: -1,
      onDismiss: onClose,
      backdrop: () => backdropEl,
      ignoreWithin: "[data-swipe-actions]",
    }}
  >
    <MobileSessionList active={open} onSessionSelect={onClose} {onOpenServers} />
  </div>
{/if}

<style>
  .drawer-hidden {
    visibility: hidden;
    pointer-events: none;
  }

  .drawer-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(0, 0, 0, 0.42);
    -webkit-tap-highlight-color: transparent;
  }

  .drawer-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    width: min(21.5rem, 88vw);
    z-index: 51;
    /* Opaque, and the sidebar's own colour: this drawer *is* the session
       sidebar on a phone. `--solus-container-bg` is 98% and let conversation
       text show through the task titles; a list you scan has to sit on its own
       surface. */
    background: var(--solus-sidebar-bg);
    box-shadow:
      0 0 0 0.03125rem var(--hairline-strong),
      1.5rem 0 3.75rem -1.25rem rgba(0, 0, 0, 0.5);
    overflow: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    will-change: transform;
    touch-action: pan-y;
    /* List chrome, not copy — long-press must swipe or tap, never select. */
    user-select: none;
    -webkit-user-select: none;
  }
</style>
