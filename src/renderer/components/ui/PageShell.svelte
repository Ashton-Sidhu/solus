<script lang="ts">
  import type { Snippet } from "svelte";
  import { XIcon } from "phosphor-svelte";
  import { PAGE_ICON_BTN } from "../../lib/page-chrome";

  /** Scroll shell for full-page library surfaces (Automations, Tasks, Folio,
   *  Plans): a centered content column with floating corner chrome. The parent
   *  must be `relative flex flex-col` with a container-type (`@container` or a
   *  named CSS container) so the corners anchor and the responsive variants in
   *  the column resolve. */
  interface Props {
    onClose?: () => void;
    /** Floating chrome pinned to the top-left corner (e.g. frame expand). */
    leading?: Snippet;
    /** Floating chrome pinned to the top-right corner, before close. */
    trailing?: Snippet;
    children: Snippet;
  }
  let { onClose, leading, trailing, children }: Props = $props();
</script>

{#if leading}
  <!-- Pinned to the top-left corner, so on the mac editor window this lands
       under the traffic lights whenever this page is the leftmost chrome
       (sidebar collapsed). Clear them with the shared lead inset; a no-op
       otherwise and off-mac. -->
  <div class="absolute left-[max(0.625rem,var(--solus-chrome-lead-inset,0px))] top-2.5 z-10 flex items-center gap-1">
    {@render leading()}
  </div>
{/if}
{#if trailing || onClose}
  <div class="absolute right-2.5 top-2.5 z-10 flex items-center gap-1">
    {#if trailing}{@render trailing()}{/if}
    {#if onClose}
      <button type="button" class={PAGE_ICON_BTN} onclick={onClose} aria-label="Close">
        <XIcon size={16} />
      </button>
    {/if}
  </div>
{/if}

<div
  class="min-h-0 flex-1 overflow-y-auto overscroll-y-contain [scrollbar-width:thin]"
>
  <div
    class="mx-auto w-full max-w-[72rem] px-8 pb-12 pt-10 @min-[90rem]:max-w-[82rem] @min-[110rem]:max-w-[94rem] @max-[44rem]:px-5 @max-[44rem]:pt-9 @max-[34rem]:px-4"
  >
    {@render children()}
  </div>
</div>
