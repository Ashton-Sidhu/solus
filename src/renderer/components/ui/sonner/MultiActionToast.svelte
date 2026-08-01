<script lang="ts">
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import InfoIcon from "@lucide/svelte/icons/info";
  import OctagonXIcon from "@lucide/svelte/icons/octagon-x";
  import RotateCcwIcon from "@lucide/svelte/icons/rotate-ccw";
  import XIcon from "@lucide/svelte/icons/x";

  type ToastActionButton = { label: string; onClick: () => void };

  let {
    message,
    variant = "info",
    actions = [],
    closeToast,
  }: {
    message: string;
    variant?: "info" | "success" | "error" | "undo";
    actions?: ToastActionButton[];
    closeToast?: () => void;
  } = $props();

  const Icon = $derived(
    variant === "error"
      ? OctagonXIcon
      : variant === "success"
        ? CircleCheckIcon
        : variant === "undo"
          ? RotateCcwIcon
          : InfoIcon,
  );

  /* The icon chip is the only tinted element, so it carries the whole signal.
     Undo stays neutral — a reversible edit isn't news. */
  const tone = $derived(
    variant === "error"
      ? "var(--solus-status-error)"
      : variant === "success"
        ? "var(--solus-status-complete)"
        : variant === "undo"
          ? "var(--solus-text-secondary)"
          : "var(--solus-accent)",
  );

  /* No action is ever filled. A toast is transient and self-dismissing, so a
     solid accent button overpowers the message it's attached to — at this size
     the fill reads as a blob, not a call to action. The lead action earns its
     weight from a hairline and semibold label instead. */
</script>

{#snippet actionButton(action: ToastActionButton, isLead: boolean)}
  <button
    type="button"
    class={isLead
      ? "inline-flex h-[1.625rem] shrink-0 cursor-pointer items-center rounded-lg border border-(--solus-popover-border) bg-(--solus-surface-hover) px-2.5 text-xs font-semibold text-(--solus-text-primary) transition-[background-color,border-color,scale] duration-100 ease-out hover:border-[color-mix(in_srgb,var(--solus-text-primary)_22%,transparent)] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:px-3.5"
      : "inline-flex h-[1.625rem] shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 text-xs font-medium text-(--solus-text-secondary) transition-[background-color,color,scale] duration-100 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.97] focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:px-3"}
    onclick={() => {
      action.onClick();
      closeToast?.();
    }}
  >
    {action.label}
  </button>
{/snippet}

<div
  class="flex w-full items-start gap-2.5 rounded-[14px] border border-(--solus-popover-border) bg-(--solus-popover-bg) py-2.5 pr-2 pl-2.5 shadow-(--solus-toast-shadow) backdrop-blur-xl [animation:toast-card-in_260ms_var(--ease-modal)_both]"
  style="--tone:{tone}"
>
  <span
    class="flex size-[1.375rem] shrink-0 items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--tone)_13%,transparent)] text-(--tone) shadow-[inset_0_0_0_0.0313rem_color-mix(in_srgb,var(--tone)_20%,transparent)]"
  >
    <Icon class="size-[0.8125rem]" strokeWidth={2.25} />
  </span>

  <!-- flow-root, not a flex row: the controls float, so only the lines they
       actually sit beside are shortened and everything below them runs the full
       width of the card. A flex row reserved their width for the whole column
       height, which broke one sentence into three ragged lines with dead space
       under the buttons — and it did that for any message, not just this one.
       The three heights are one number: leading-[1.7] makes the line box 22px,
       which is the icon chip, which is the cluster once -my-[0.125rem] trims the
       26px buttons to it. So the chip lands on the first line without a nudge,
       the cluster shortens that line and no other, and the buttons overhang into
       leading rather than into the ascenders of line 2. Coarse pointers get 40px
       targets that can't fit a line box, so there the cluster keeps its full
       height and the text resumes a line lower instead of running underneath. -->
  <div class="min-w-0 flex-1 flow-root">
    <div
      class="float-right -my-[0.125rem] ml-2 flex h-[1.625rem] items-center gap-1 [@media(pointer:coarse)]:my-0 [@media(pointer:coarse)]:h-10"
    >
      {#each actions as action, index}
        {@render actionButton(action, index === 0)}
      {/each}

      <!-- Always laid out and always visible: fading it in on hover left a 22px
           hole at the trailing edge, so the action read as floating mid-card
           instead of anchoring the row. Quiet at rest, firms up on hover. -->
      <button
        type="button"
        aria-label="Dismiss"
        class="flex size-[1.375rem] shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) opacity-55 transition-[opacity,background-color,color] duration-100 ease-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) hover:opacity-100 focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:opacity-100 focus-visible:outline-none [@media(pointer:coarse)]:size-9"
        onclick={() => closeToast?.()}
      >
        <XIcon class="size-3.5" />
      </button>
    </div>

    <p
      class="text-[0.8125rem] leading-[1.7] font-medium break-words text-pretty text-(--solus-text-primary)"
    >
      {message}
    </p>
  </div>
</div>
