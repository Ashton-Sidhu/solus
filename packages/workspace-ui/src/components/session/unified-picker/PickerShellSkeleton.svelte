<script lang="ts">
  import { Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import { getPopoverLayer } from "../../popoverLayer.svelte";
  import { portal } from "../../portal";
  import { Skeleton } from "../../ui/skeleton";
  import PickerListSkeleton from "./PickerListSkeleton.svelte";
  import PickerPreviewSkeleton from "./PickerPreviewSkeleton.svelte";

  /**
   * The search's frame while its module loads: the card at its real size, with
   * placeholders where the box, the types, the list and the preview will be.
   * The search then replaces it in place. Without it, the first ⌘P of a
   * session showed nothing until the code arrived.
   */
  interface Props {
    /** Close from the frame: a scrim click or Escape. */
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  const layer = getPopoverLayer();
  /** One placeholder for each type tab, in the measure of its label. */
  const TAB_WIDTHS = ["2rem", "4rem", "3rem", "3.25rem", "6rem", "5.5rem", "4rem"];
</script>

{#if layer.el}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal={layer.el}
    class="pointer-events-auto fixed inset-0 z-[200] flex items-center justify-center overflow-hidden modal-backdrop"
    role="presentation"
    onmousedown={(event) => event.target === event.currentTarget && onClose()}
  >
    <div
      class="flex h-[70%] w-[76%] max-w-full flex-col overflow-hidden rounded-3xl bg-popover text-menu text-popover-foreground shadow-[var(--solus-popover-shadow),0_0_0_0.5px_var(--hairline-strong),inset_0_0.0625rem_0_rgba(255,255,255,0.14)] outline-none"
      role="dialog"
      aria-label="Search"
      aria-busy="true"
      tabindex="-1"
      data-testid="picker-shell-skeleton"
      {@attach (el) => el.focus()}
      onkeydown={(event) => event.key === "Escape" && onClose()}
    >
      <div class="flex h-[3.3125rem] shrink-0 items-center gap-3 px-5">
        <MagnifyingGlassIcon size={14} class="shrink-0 text-(--solus-text-tertiary) opacity-65" />
        <span class="text-(--solus-text-tertiary)">Search</span>
      </div>
      <div class="flex shrink-0 items-center gap-3 border-b border-(--solus-menu-hairline) px-6 pb-4" aria-hidden="true">
        {#each TAB_WIDTHS as width, i (i)}
          <Skeleton class="h-2.5 rounded-[0.25rem]" style="width:{width}" />
        {/each}
      </div>
      <div class="flex min-h-0 flex-1 overflow-hidden">
        <div class="w-1/2 shrink-0 overflow-hidden border-r border-(--solus-menu-hairline) px-2 pt-2">
          <PickerListSkeleton label="Loading search" />
        </div>
        <div class="min-w-0 flex-1">
          <PickerPreviewSkeleton />
        </div>
      </div>
    </div>
  </div>
{/if}
