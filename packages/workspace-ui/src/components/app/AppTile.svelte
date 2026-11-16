<script lang="ts">
  /**
   * An app's tile: its first letter on its hue (`@solus/client-core/app-tile`).
   * The sidebar draws it small beside the places; the Overview draws it large
   * at the head of the page, and at middle size in the colour picker. The same hue reads in light and dark mode.
   */
  interface Props {
    monogram: string;
    hue: number;
    size?: "sm" | "md" | "lg";
  }
  let { monogram, hue, size = "sm" }: Props = $props();
</script>

<span
  class="flex shrink-0 items-center justify-center leading-none font-semibold bg-[oklch(0.9_0.06_var(--app-hue))] text-[oklch(0.42_0.1_var(--app-hue))] dark:bg-[oklch(0.38_0.07_var(--app-hue))] dark:text-[oklch(0.9_0.05_var(--app-hue))] {size === 'lg'
    ? 'size-14 rounded-2xl text-2xl'
    : size === 'md'
      ? 'size-8 rounded-lg text-sm'
      : 'size-[1.125rem] rounded-[0.3125rem] text-[0.625rem]'}"
  style:--app-hue={hue}
  aria-hidden="true">{monogram}</span
>
