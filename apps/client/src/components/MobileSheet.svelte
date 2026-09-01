<script lang="ts">
  import type { Snippet } from "svelte";
  import { X as XIcon } from "@lucide/svelte";
  import { swipeDismiss } from "../lib/swipe-dismiss";

  interface Props {
    open: boolean;
    onClose: () => void;
    title: string;
    /** The mono line under the title — a path, a count, a destination. */
    subtitle?: string;
    /** Sheets that list rather than choose get the taller stop. */
    tall?: boolean;
    children: Snippet;
  }
  let { open, onClose, title, subtitle, tall = false, children }: Props = $props();

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
    class="fixed inset-0 z-40 bg-black/45 [-webkit-tap-highlight-color:transparent]"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    onclick={onClose}
    onkeydown={(e) => e.key === "Escape" && onClose()}
  ></div>

  <!-- Opaque popover surface on a real scrim. A sheet has to read as a sheet:
       one named step of the elevation ladder above the thread, never a frosted
       pane the conversation shows through. -->
  <div
    bind:this={sheetEl}
    class="fixed inset-x-0 bottom-0 z-[41] flex flex-col select-none overflow-y-auto overscroll-contain rounded-t-[1.625rem] bg-(--popover) shadow-(--solus-popover-shadow) pb-[max(0.875rem,env(safe-area-inset-bottom,0px))] will-change-transform [-webkit-overflow-scrolling:touch] [-webkit-user-select:none] {tall
      ? 'top-24'
      : 'max-h-[85dvh]'}"
    class:invisible={!visible}
    class:pointer-events-none={!visible}
    use:swipeDismiss={{ axis: "y", sign: 1, onDismiss: onClose, backdrop: () => backdropEl }}
  >
    <!-- The grabber is the dismiss affordance the gesture table promises. -->
    <div class="flex shrink-0 justify-center pt-2 pb-0.5">
      <span class="h-1 w-[2.375rem] rounded-full bg-(--foreground) opacity-[0.22]"></span>
    </div>

    <div class="flex h-13 shrink-0 items-center gap-2 pr-2.5 pl-[1.125rem]">
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-base font-semibold tracking-[-0.012em] text-(--solus-text-primary)">{title}</h2>
        {#if subtitle}
          <div class="mt-0.5 truncate font-mono text-xs text-(--muted-foreground)">{subtitle}</div>
        {/if}
      </div>
      <button
        type="button"
        class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-(--wash-3) text-(--muted-foreground) transition-colors duration-[120ms] active:bg-(--solus-accent-light) active:text-(--solus-text-primary) [-webkit-tap-highlight-color:transparent]"
        aria-label="Close"
        onclick={onClose}
      >
        <XIcon size={14} />
      </button>
    </div>

    {@render children()}
  </div>
{/if}
