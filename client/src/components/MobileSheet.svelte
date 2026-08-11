<script lang="ts">
  import type { Snippet } from "svelte";
  import { XIcon } from "phosphor-svelte";
  import { swipeDismiss } from "../lib/swipe-dismiss";

  interface Props {
    open: boolean;
    onClose: () => void;
    title: string;
    children: Snippet;
  }
  let { open, onClose, title, children }: Props = $props();

  // Same lazy-mount + slide-up choreography as MobilePlusMenu: mounted once,
  // then shown/hidden so sheet-local state survives reopens.
  let hasMounted = $state(false);
  let visible = $state(false);
  let sheetEl: HTMLDivElement | undefined = $state();
  let backdropEl: HTMLDivElement | undefined = $state();

  $effect(() => {
    if (open) hasMounted = true;
  });

  $effect(() => {
    if (!hasMounted) return;
    if (open) {
      visible = true;
      requestAnimationFrame(() => {
        if (!sheetEl || !backdropEl) return;
        sheetEl.style.transform = "translateY(100%)";
        backdropEl.style.opacity = "0";
        requestAnimationFrame(() => {
          if (!sheetEl || !backdropEl) return;
          sheetEl.style.transition = "transform 0.22s cubic-bezier(0.32, 0.72, 0, 1)";
          backdropEl.style.transition = "opacity 0.12s ease";
          sheetEl.style.transform = "";
          backdropEl.style.opacity = "";
        });
      });
    } else if (visible) {
      if (sheetEl && backdropEl) {
        sheetEl.style.transition = "transform 0.18s ease-in";
        backdropEl.style.transition = "opacity 0.12s ease";
        sheetEl.style.transform = "translateY(100%)";
        backdropEl.style.opacity = "0";
        const done = () => {
          // Bail if a reopen landed mid-close, else visible sticks false while
          // open stays true and the sheet can't be reopened.
          if (open) return;
          visible = false;
          if (sheetEl) { sheetEl.style.transition = ""; sheetEl.style.transform = ""; }
          if (backdropEl) { backdropEl.style.transition = ""; backdropEl.style.opacity = ""; }
        };
        sheetEl.addEventListener("transitionend", done, { once: true });
        setTimeout(done, 200);
      } else {
        visible = false;
      }
    }
  });
</script>

{#if hasMounted}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={backdropEl}
    class="fixed inset-0 z-40 bg-black/35 [-webkit-tap-highlight-color:transparent]"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    onclick={onClose}
    onkeydown={(e) => e.key === "Escape" && onClose()}
  ></div>

  <div
    bind:this={sheetEl}
    class="fixed bottom-0 inset-x-0 z-[41] max-h-[85dvh] select-none overflow-y-auto overscroll-contain rounded-t-2xl border-t border-(--solus-popover-border) bg-(--solus-popover-bg) backdrop-blur-[1.25rem] backdrop-saturate-[1.1] shadow-(--solus-popover-shadow) px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom,0px))] will-change-transform [-webkit-overflow-scrolling:touch] [-webkit-user-select:none]"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    use:swipeDismiss={{ axis: "y", sign: 1, onDismiss: onClose, backdrop: () => backdropEl }}
  >
    <div class="w-9 h-1 mx-auto mb-3.5 rounded-[0.125rem] bg-(--solus-text-muted) opacity-30"></div>

    <div class="relative flex items-center justify-center h-9 mb-3">
      <button
        type="button"
        class="absolute left-0 flex items-center justify-center w-9 h-9 rounded-full border border-(--solus-container-border) cursor-pointer bg-(--solus-surface-hover) font-secondary text-(--solus-text-secondary) transition-colors duration-[120ms] active:bg-(--solus-accent-light) active:text-(--solus-text-primary) [-webkit-tap-highlight-color:transparent]"
        aria-label="Close"
        onclick={onClose}
      >
        <XIcon size={18} weight="bold" />
      </button>
      <h2 class="text-[0.9375rem] font-semibold text-(--solus-text-primary)">{title}</h2>
    </div>

    {@render children()}
  </div>
{/if}
