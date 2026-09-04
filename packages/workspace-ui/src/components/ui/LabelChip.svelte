<script lang="ts">
  import { cn } from "../../lib/utils";

  let {
    label,
    color = "var(--solus-accent)",
    class: className,
  }: {
    label: string;
    color?: string;
    class?: string;
  } = $props();
</script>

<span
  class={cn(
    "inline-flex h-[19px] max-w-full items-center rounded-full bg-[color-mix(in_oklch,var(--label-color)_22%,var(--background))] px-2 font-medium text-[color-mix(in_oklch,var(--label-color)_62%,var(--foreground))]",
    className,
  )}
  style="--label-color: {color}"
  title={label}
>
  <span class="truncate">{label}</span>
</span>
