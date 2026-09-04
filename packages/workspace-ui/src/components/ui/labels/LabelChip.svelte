<script lang="ts">
  import { cn } from "../../../lib/utils";
  import { labelTint } from "./label-color";

  /** One label as every surface draws it: a pastel pill mixed from the host's
   *  colour, or from the brand accent for a label with none. */
  let {
    label,
    color,
    class: className,
  }: {
    label: string;
    /** The host's colour, bare hex or CSS. Omit for a local task label. */
    color?: string;
    class?: string;
  } = $props();
</script>

<span
  class={cn(
    "inline-flex h-[19px] max-w-full items-center rounded-full bg-[color-mix(in_oklch,var(--label-color)_22%,var(--background))] px-2 font-medium text-[color-mix(in_oklch,var(--label-color)_62%,var(--foreground))]",
    className,
  )}
  style="--label-color: {labelTint(color)}"
  title={label}
>
  <span class="truncate">{label}</span>
</span>
