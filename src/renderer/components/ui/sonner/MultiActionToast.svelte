<script lang="ts">
  import CircleCheckIcon from "@lucide/svelte/icons/circle-check";
  import InfoIcon from "@lucide/svelte/icons/info";
  import OctagonXIcon from "@lucide/svelte/icons/octagon-x";

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
  class="flex w-[356px] max-w-full flex-col gap-2.5 rounded-lg border border-(--solus-popover-border) bg-(--solus-popover-bg) px-3 py-2.5 shadow-(--solus-popover-shadow)"
>
  <div class="flex items-start gap-2">
    {#if variant === "error"}
      <OctagonXIcon
        class="mt-px size-4 shrink-0 text-(--solus-status-error)"
      />
    {:else if variant === "success"}
      <CircleCheckIcon
        class="mt-px size-4 shrink-0 text-(--solus-status-complete)"
      />
    {:else}
      <InfoIcon class="mt-px size-4 shrink-0 text-(--solus-accent)" />
    {/if}
    <p
      class="min-w-0 flex-1 text-[0.8125rem] leading-[1.4] text-pretty text-(--solus-text-primary)"
    >
      {message}
    </p>
  </div>

  {#if actions.length}
    <div class="flex flex-wrap items-center justify-end gap-1.5">
      {#each actions as action, index}
        <button
          type="button"
          class={index === 0
            ? "inline-flex shrink-0 cursor-pointer items-center rounded-lg border-0 bg-(--solus-accent) px-2.5 py-1.5 text-[0.6875rem] font-semibold text-(--solus-text-on-accent) transition-[filter,scale] duration-100 ease-in-out hover:brightness-[1.07] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_55%,transparent)] [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-3.5"
            : "inline-flex shrink-0 cursor-pointer items-center rounded-lg border-0 bg-transparent px-2 py-1.5 text-[0.6875rem] font-medium text-(--solus-text-tertiary) transition-[background-color,color,scale] duration-100 ease-in-out hover:bg-(--solus-surface-hover) hover:text-(--solus-text-secondary) active:scale-[0.96] focus-visible:bg-(--solus-accent-light) focus-visible:text-(--solus-text-primary) focus-visible:outline-none [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:px-3.5"}
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
