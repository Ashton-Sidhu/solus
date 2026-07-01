<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { cubicOut } from "svelte/easing";
  import {
    CheckCircleIcon,
    WarningCircleIcon,
    InfoIcon,
    ArrowCounterClockwiseIcon,
  } from "phosphor-svelte";
  import type { ToastVariant } from "../contexts/toast.store.svelte";

  interface Props {
    /** The line shown to the user, e.g. "Comment deleted". */
    message: string;
    /** Visual tone. Defaults to "info". Drives aria-live + the Cmd+Z undo gesture. */
    variant?: ToastVariant;
    /** Label for the trailing action button; omit for a message-only toast. */
    actionLabel?: string;
    /** How long the toast stays before auto-dismissing, in ms. */
    duration?: number;
    /** Where the toast anchors within its positioned host. Defaults to "bottom". */
    placement?: "top" | "bottom";
    /** Called when the user activates the action button. */
    onAction?: () => void;
    /** Called when the toast auto-dismisses or is manually dismissed. */
    onDismiss: () => void;
  }

  let {
    message,
    variant = "info",
    actionLabel,
    duration = 6000,
    placement = "bottom",
    onAction,
    onDismiss,
  }: Props = $props();

  // Leading glyph + its tone per variant. Success/error lean on the app's status
  // colours; info/undo stay on the brand accent so the toast reads on-theme.
  const ICONS = {
    success: CheckCircleIcon,
    error: WarningCircleIcon,
    info: InfoIcon,
    undo: ArrowCounterClockwiseIcon,
  } as const;
  const ICON_COLORS: Record<ToastVariant, string> = {
    success: "text-(--solus-status-complete)",
    error: "text-(--solus-status-error)",
    info: "text-(--solus-accent)",
    undo: "text-(--solus-accent)",
  };
  const Icon = $derived(ICONS[variant]);

  // Hovering pauses the dismissal timer so a user reading the message never
  // loses the chance to act; leaving re-arms it from the remaining time.
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Seeded once from the prop; the countdown then ticks down on its own.
  let remaining = untrack(() => duration);
  let startedAt = 0;

  function arm() {
    clearTimer();
    startedAt = performance.now();
    timer = setTimeout(() => onDismiss(), remaining);
  }

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function pauseTimer() {
    clearTimer();
    remaining = Math.max(0, remaining - (performance.now() - startedAt));
  }

  function handleEnter() {
    pauseTimer();
  }

  function handleLeave() {
    arm();
  }

  function handleAction() {
    clearTimer();
    onAction?.();
  }

  // Cmd/Ctrl+Z is the universal "undo" gesture — honour it while an undo toast is
  // visible, but never hijack undo inside a text field the user is editing.
  function handleKeydown(e: KeyboardEvent) {
    if (variant !== "undo" || !onAction) return;
    if (e.shiftKey || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.isContentEditable ||
        /^(input|textarea|select)$/i.test(target.tagName))
    ) {
      return;
    }
    e.preventDefault();
    handleAction();
  }

  // Enter + slight rise and pop so the toast announces itself rather than fading
  // in flat. Svelte plays it in reverse on exit.
  function toastTransition(_node: Element, { duration: d = 220 } = {}) {
    const dir = placement === "top" ? -1 : 1;
    return {
      duration: d,
      css: (t: number) => {
        const e = cubicOut(t);
        return `opacity:${t}; transform: translateY(${(1 - e) * 10 * dir}px) scale(${0.97 + e * 0.03});`;
      },
    };
  }

  onMount(() => {
    arm();
    window.addEventListener("keydown", handleKeydown, true);
  });

  onDestroy(() => {
    clearTimer();
    window.removeEventListener("keydown", handleKeydown, true);
  });
</script>

<!-- Top placement pins to the top-right of the positioned shell, just below its
     chrome — the conventional toast spot. The high z-index clears in-shell modals
     (plan/document panels reach 10003); it's scoped to the shell's isolation
     context, so it never fights the app's global overlay layer. On narrow
     viewports it spans the width so it stays readable instead of crowding. -->
<div
  class="pointer-events-auto absolute z-30 flex w-max max-w-[min(22rem,calc(100vw-2rem))] items-center gap-2.5 rounded-[0.75rem] border border-(--solus-container-border) bg-(--solus-popover-bg) py-1.5 pr-1.5 pl-2.5 text-[0.8125rem] leading-[1.35] text-(--solus-text-primary) shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.04),0_0.375rem_1rem_rgba(0,0,0,0.10)] [.dark_&]:shadow-[0_0.0625rem_0.125rem_rgba(0,0,0,0.4),0_0.375rem_1.25rem_rgba(0,0,0,0.5)] {placement === 'top'
    ? 'top-4 right-4 z-[10005] max-[30rem]:left-3 max-[30rem]:right-3 max-[30rem]:w-auto max-[30rem]:max-w-none'
    : 'bottom-[4.5rem] left-1/2 -translate-x-1/2'}"
  role="status"
  aria-live={variant === "error" ? "assertive" : "polite"}
  data-testid="undo-toast"
  transition:toastTransition
  onmouseenter={handleEnter}
  onmouseleave={handleLeave}
>
  <Icon size={16} weight="fill" class="shrink-0 {ICON_COLORS[variant]}" />
  <span class="min-w-0 flex-1 font-medium">{message}</span>
  {#if actionLabel}
    <button
      type="button"
      class="shrink-0 cursor-pointer rounded-[0.5rem] border-0 bg-transparent px-2 py-1 text-[0.75rem] font-semibold text-(--solus-accent) transition-colors duration-100 hover:bg-(--solus-accent-light) focus-visible:bg-(--solus-accent-light) focus-visible:outline-none active:scale-[0.97]"
      data-testid="undo-toast-action"
      onclick={handleAction}
    >
      {actionLabel}
    </button>
  {/if}
</div>
