<script lang="ts">
  import { ArrowClockwiseIcon, WarningIcon } from "phosphor-svelte";

  interface Props {
    title: string;
    message: string;
    retryLabel?: string;
    onRetry: () => void;
  }

  let { title, message, retryLabel = "Retry", onRetry }: Props = $props();
</script>

<div class="flex-1 flex items-center justify-center px-6">
  <div
    class="flex flex-col items-center text-center gap-3 py-8 px-5 rounded-xl border border-(--solus-container-border) max-w-xs"
    style="background:var(--solus-surface-hover)"
  >
    <span
      class="flex items-center justify-center rounded-full"
      style="width:2.25rem;height:2.25rem;background:var(--solus-status-error-bg);color:var(--solus-status-error)"
    >
      <WarningIcon size={18} weight="duotone" />
    </span>
    <div class="flex flex-col gap-1">
      <span class="text-[0.75rem] font-medium text-(--solus-text-primary)">
        {title}
      </span>
      <span
        class="text-[0.6875rem] text-(--solus-text-tertiary) leading-snug"
      >
        {message}
      </span>
    </div>
    <button
      onclick={onRetry}
      class="flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1 rounded-md cursor-pointer transition-colors text-(--solus-text-primary) hover:bg-(--solus-surface-active) border border-(--solus-container-border)"
    >
      <ArrowClockwiseIcon size={11} weight="bold" />
      {retryLabel}
    </button>
  </div>
</div>
