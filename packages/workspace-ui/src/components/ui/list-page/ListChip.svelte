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

{#if chip.iconOnly && chip.icon}
  <span role="img" aria-label={chip.label} title={chip.label} class="inline-flex h-[1.5em] shrink-0 items-center justify-center gap-[0.2em] text-workspace-chrome" style="color: {skin.color}">
    <chip.icon class="size-[1em]" aria-hidden="true" />
    {#if chip.statusIcon}
      <chip.statusIcon class={chip.spinning ? "size-[0.65em] animate-spin motion-reduce:animate-none" : "size-[0.65em]"} aria-hidden="true" />
    {/if}
  </span>
{:else if chip.labelColor}
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
