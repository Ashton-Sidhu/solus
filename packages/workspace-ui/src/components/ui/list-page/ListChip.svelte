<script lang="ts">
  import { chipSkin, type ListChipSpec } from "./list-page";

  /** Slot 4 of the row: the domain (label / branch), a state that needs colour
   *  (conflicts, blocked), or — on pages whose rows travel outside their group,
   *  like the PR inbox — the lifecycle state itself. Neutral chips ring; tinted
   *  chips fill and drop the ring. */
  interface Props {
    chip: ListChipSpec;
  }
  let { chip }: Props = $props();

  const skin = $derived(
    chip.labelColor
      ? {
          background: `color-mix(in oklch, ${chip.labelColor} 22%, var(--background))`,
          color: `color-mix(in oklch, ${chip.labelColor} 62%, var(--foreground))`,
          boxShadow: "none",
        }
      : chipSkin(chip.tint, chip.emphasis),
  );
</script>

<span
  class="inline-flex h-[19px] shrink-0 items-center gap-1 {chip.labelColor ? 'rounded-full font-medium' : 'rounded-md font-normal'} px-[7px] text-xs whitespace-nowrap {chip.mono
 ? ''
 : ''}"
  style="background: {skin.background}; color: {skin.color}; box-shadow: {skin.boxShadow}"
>
  {#if chip.icon}
    <chip.icon size={11} class="shrink-0" aria-hidden="true" />
  {/if}
  {chip.label}
</span>
