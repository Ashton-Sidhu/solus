<script lang="ts">
  import { CircleAlert as WarningCircleIcon } from "@lucide/svelte";

  let { feature, hostLabel }: { feature: string; hostLabel: string } = $props();
</script>

<div
  class="flex min-h-40 flex-col items-center justify-center gap-2 rounded-2xl border border-(--solus-container-border) px-6 text-center"
  role="status"
>
  <WarningCircleIcon size={18} class="text-(--solus-text-tertiary)" />
  <p class="text-workspace-chrome font-medium text-(--solus-text-secondary)">
    {feature} are not supported on {hostLabel}.
  </p>
  <p class="max-w-sm text-xs text-(--solus-text-tertiary)">
    Choose another connected host to use this settings surface.
  </p>
</div>
