<script lang="ts">
  import { tick } from "svelte";
  import MobileSessionList from "./MobileSessionList.svelte";
  import { blurActiveTextInputOnMobile } from "@solus/workspace-ui/lib/inputFocus";
  import { swipeDismiss } from "../lib/swipe-dismiss";

  interface Props {
    open: boolean;
    onClose: () => void;
    onOpenServers: () => void;
  }
  let { open, onClose, onOpenServers }: Props = $props();

  // 344 of 393 on an iPhone 15: wide enough that a 62px row can state a title,
  // a project and a run count without any of them truncating, and narrow enough
  // that the conversation stays visible behind the scrim.
  const DRAWER_WIDTH = 344;

  let hasMounted = $state(false);
  let visible = $state(false);

  $effect(() => {
    if (open) hasMounted = true;
  });

  $effect(() => {
    if (!hasMounted) return;
    if (open) {
      visible = true;
      requestAnimationFrame(() => {
        if (!drawerEl || !backdropEl) return;
        drawerEl.style.transform = `translateX(-${DRAWER_WIDTH}px)`;
        backdropEl.style.opacity = '0';
        requestAnimationFrame(() => {
          if (!drawerEl || !backdropEl) return;
          drawerEl.style.transition = 'transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)';
          backdropEl.style.transition = 'opacity 0.16s ease';
          drawerEl.style.transform = '';
          backdropEl.style.opacity = '';
        });
      });
    } else if (visible) {
      if (drawerEl && backdropEl) {
        drawerEl.style.transition = 'transform 0.18s ease-in';
        backdropEl.style.transition = 'opacity 0.14s ease';
        drawerEl.style.transform = `translateX(-${DRAWER_WIDTH}px)`;
        backdropEl.style.opacity = '0';
        const done = () => {
          // A reopen may have landed while this close animation was in flight.
          // Bailing keeps open/visible in sync — otherwise visible sticks at
          // false while open stays true, and the toggle (which only sets
          // open=true) can never re-trigger, wedging the drawer shut.
          if (open) return;
          visible = false;
          if (drawerEl) { drawerEl.style.transition = ''; drawerEl.style.transform = ''; }
          if (backdropEl) { backdropEl.style.transition = ''; backdropEl.style.opacity = ''; }
          tick().then(() => requestAnimationFrame(() => blurActiveTextInputOnMobile()));
        };
        drawerEl.addEventListener('transitionend', done, { once: true });
        setTimeout(done, 200);
      } else {
        visible = false;
      }
    }
  });

  let drawerEl: HTMLDivElement | undefined = $state();
  let backdropEl: HTMLDivElement | undefined = $state();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }
</script>

{#if hasMounted}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="drawer-backdrop"
    class:drawer-hidden={!visible}
    onclick={onClose}
    onkeydown={handleKeydown}
  ></div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={drawerEl}
    class="drawer-panel"
    class:drawer-hidden={!visible}
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
