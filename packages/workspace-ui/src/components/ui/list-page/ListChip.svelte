<script lang="ts">
  import LabelChip from "../labels/LabelChip.svelte";
  import { chipSkin, type ListChipSpec } from "./list-page";

  /** Slot 4 of the row: the domain (label / branch), a state that needs colour
   *  (conflicts, blocked), or — on pages whose rows travel outside their group,
   *  like the PR inbox — the lifecycle state itself. A domain label is the one
   *  shared pastel pill; neutral chips ring; tinted chips fill and drop the ring. */
  interface Props {
    chip: ListChipSpec;
  }
  let { chip }: Props = $props();

  const skin = $derived(chipSkin(chip.tint, chip.emphasis));
</script>

{#if chip.labelColor}
  <LabelChip label={chip.label} color={chip.labelColor} class="shrink-0 text-xs whitespace-nowrap" />
{:else}
  <span
    class="inline-flex h-[19px] shrink-0 items-center gap-1 rounded-md px-[7px] text-xs font-normal whitespace-nowrap"
    style="background: {skin.background}; color: {skin.color}; box-shadow: {skin.boxShadow}"
  >
    {#if chip.icon}
      <chip.icon size={11} class="shrink-0" aria-hidden="true" />
    {/if}
    {chip.label}
  </span>
{/if}
