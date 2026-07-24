<script lang="ts">
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import InfoIcon from "@lucide/svelte/icons/info";
  import OctagonXIcon from "@lucide/svelte/icons/octagon-x";
  import XIcon from "@lucide/svelte/icons/x";

  let {
    message,
    variant = "info",
    actions = [],
    closeToast,
  }: {
    message: string;
    variant?: "info" | "success" | "error" | "undo";
    actions?: { label: string; onClick: () => void }[];
    closeToast?: () => void;
  } = $props();
</script>

<div
  class="relative flex w-[360px] max-w-full items-start gap-2.5 rounded-xl border border-(--solus-popover-border) bg-(--solus-popover-bg) py-3 pl-3.5 pr-2.5 shadow-(--solus-popover-shadow)"
>
  {#if variant === "error"}
    <OctagonXIcon class="mt-px size-[1.0625rem] shrink-0 text-(--solus-status-error)" />
  {:else if variant === "success"}
    <CircleCheckIcon class="mt-px size-[1.0625rem] shrink-0 text-(--solus-status-complete)" />
  {:else}
    <InfoIcon class="mt-px size-[1.0625rem] shrink-0 text-(--solus-accent)" />
  {/if}

  <div class="flex min-w-0 flex-1 flex-col gap-2.5">
    <p
      class="min-w-0 text-[0.8125rem] font-medium leading-[1.45] text-pretty text-(--solus-text-primary)"
    >
      {message}
    </p>

    {#if actions.length}
      <div class="flex flex-wrap items-center gap-1.5">
        {#each actions as action, index}
          <button
            type="button"
            class={index === 0
              ? "inline-flex shrink-0 cursor-pointer items-center rounded-lg border-0 bg-(--solus-accent) px-3 py-1.5 text-xs font-semibold text-(--solus-text-on-accent) transition-[filter,scale] duration-100 ease-in-out hover:brightness-[1.07] active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-3.5"
              : "inline-flex shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-xs font-medium text-(--solus-text-secondary) transition-[background-color,color,scale] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.97] focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-3.5"}
            onclick={() => {
              action.onClick();
              closeToast?.();
            }}
          >
            {action.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <button
    type="button"
    aria-label="Dismiss"
    class="-mr-0.5 -mt-0.5 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--solus-text-tertiary) transition-[background-color,color] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) focus-visible:bg-(--solus-surface-hover) focus-visible:text-(--solus-text-primary) focus-visible:outline-none"
    onclick={() => closeToast?.()}
  >
    <XIcon class="size-4" />
  </button>
</div>
