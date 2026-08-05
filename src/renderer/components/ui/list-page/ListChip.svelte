<script lang="ts">
  import { chipSkin, type ListChipSpec } from "./list-page";

  /** Slot 4 of the row: a fact that varies *inside* a group. Lifecycle state is
   *  never a chip — that's what the group is for — so a chip is always either
   *  the domain (label / branch) or a state that needs colour (checks, blocked).
   *  Neutral chips ring; tinted chips fill and drop the ring. */
  interface Props {
    chip: ListChipSpec;
  }
  let { chip }: Props = $props();

  const skin = $derived(chipSkin(chip.tint));
</script>

<span
  class="inline-flex h-[19px] shrink-0 items-center rounded-md px-[7px] text-[10.5px] font-medium tracking-[.03em] {chip.mono
    ? 'font-mono'
    : ''}"
  style="background: {skin.background}; color: {skin.color}; box-shadow: {skin.boxShadow}"
>
  {chip.label}
</span>
