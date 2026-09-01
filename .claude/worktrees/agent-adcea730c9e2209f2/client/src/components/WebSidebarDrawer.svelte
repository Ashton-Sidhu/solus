<script lang="ts">
  import { tick } from "svelte";
  import MobileSessionList from "./MobileSessionList.svelte";
  import { blurActiveTextInputOnMobile } from "@renderer/lib/inputFocus";
  import { swipeDismiss } from "../lib/swipe-dismiss";

  interface Props {
    open: boolean;
    onClose: () => void;
  }
  let { open, onClose }: Props = $props();

  const DRAWER_WIDTH = 280;

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
    use:swipeDismiss={{ axis: "x", sign: -1, onDismiss: onClose, backdrop: () => backdropEl }}
  >
    <MobileSessionList onSessionSelect={onClose} />
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
    background: rgba(0, 0, 0, 0.2);
    -webkit-tap-highlight-color: transparent;
  }

  .drawer-panel {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    width: min(17.5rem, 85vw);
    z-index: 51;
    /* Frosted, not fully opaque — content shows through subtly (à la Claude/iOS). */
    background: color-mix(in srgb, var(--solus-container-bg) 80%, transparent);
    backdrop-filter: blur(1.5rem) saturate(1.1);
    -webkit-backdrop-filter: blur(1.5rem) saturate(1.1);
    border-right: 0.0625rem solid var(--solus-container-border);
    box-shadow: 0.25rem 0 1.5rem rgba(0, 0, 0, 0.2);
    overflow: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    will-change: transform;
    touch-action: pan-y;
  }
</style>
