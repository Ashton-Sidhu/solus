<script lang="ts">
  import { MagnifyingGlassIcon } from "phosphor-svelte";
  import type { Snippet } from "svelte";
  import * as Command from "../command";

  /** The filter header every list menu opens with. Its rule spans the full
   *  surface, so it sits as a sibling of the padded body inside a `p-0` menu
   *  rather than inside the body itself.
   *
   *  The field takes the rung its surface declares rather than pinning one, so
   *  it reads at the same size as the rows it filters — the menu rung on a stock
   *  menu, the dense rung on a dense one — and follows that rung down on a
   *  laptop display instead of standing a size above the list. */
  interface Props {
    value: string;
    placeholder: string;
    /** Replaces the magnifier — the branch picker puts a back button here. */
    leading?: Snippet;
    /** Overflow affordance on the right, e.g. the branch picker's `···`. */
    trailing?: Snippet;
  }
  let { value = $bindable(), placeholder, leading, trailing }: Props = $props();
</script>

<div
  class="flex items-center gap-2 border-b border-(--solus-menu-hairline) px-3 pb-2 pt-2.5 [.is-laptop-display_&]:gap-1.5 [.is-laptop-display_&]:px-2.5 [.is-laptop-display_&]:pb-1.5 [.is-laptop-display_&]:pt-2 text-(--solus-text-tertiary)"
>
  {#if leading}
    {@render leading()}
  {:else}
    <MagnifyingGlassIcon size={13} class="shrink-0 opacity-70" />
  {/if}
  <Command.Input
    bind:value
    {placeholder}
    class="h-4 flex-1 text-[length:inherit] text-(--solus-text-primary) placeholder:text-(--solus-text-tertiary)"
  />
  {#if trailing}{@render trailing()}{/if}
</div>
