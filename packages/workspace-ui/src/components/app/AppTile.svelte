<script lang="ts">
  /**
   * An app's tile: the app's own icon (`icon.svg`, from `appIconsStore`) when
   * it has one, else its first letter on its hue (`@solus/client-core/app-tile`).
   * An icon that does not load shows the letter too. The sidebar draws it small
   * beside the places and in the app pane's header, smallest in a surface tab;
   * the Overview draws it large at the head of the page, and at middle size in
   * the colour picker. The icon is the app's own artwork, as
   * on a launcher, so it shows as it is in light and dark mode; the same hue
   * reads in both.
   */
  interface Props {
    monogram: string;
    hue: number;
    /** The app's icon as an image address; null or absent for the monogram. */
    iconUrl?: string | null;
    size?: "xs" | "sm" | "md" | "lg";
  }
  let { monogram, hue, iconUrl = null, size = "sm" }: Props = $props();

  /** The address that did not load: a new icon gets its own try. */
  let failedUrl = $state<string | null>(null);
</script>

{#if iconUrl && iconUrl !== failedUrl}
  <img
    src={iconUrl}
    alt=""
    draggable="false"
    class="shrink-0 object-contain {size === 'lg'
      ? 'size-14 rounded-2xl'
      : size === 'md'
        ? 'size-8 rounded-lg'
        : size === 'sm'
          ? 'size-[1.125rem] rounded-[0.3125rem]'
          : 'size-3.5 rounded-[0.25rem]'}"
    data-testid="app-tile-icon"
    onerror={() => (failedUrl = iconUrl)}
  />
{:else}
  <span
    class="flex shrink-0 items-center justify-center leading-none font-semibold bg-[oklch(0.9_0.06_var(--app-hue))] text-[oklch(0.42_0.1_var(--app-hue))] dark:bg-[oklch(0.38_0.07_var(--app-hue))] dark:text-[oklch(0.9_0.05_var(--app-hue))] {size === 'lg'
      ? 'size-14 rounded-2xl text-2xl'
      : size === 'md'
        ? 'size-8 rounded-lg text-sm'
        : size === 'sm'
          ? 'size-[1.125rem] rounded-[0.3125rem] text-[0.625rem]'
          : 'size-3.5 rounded-[0.25rem] text-[0.5rem]'}"
    style:--app-hue={hue}
    aria-hidden="true">{monogram}</span
  >
{/if}
