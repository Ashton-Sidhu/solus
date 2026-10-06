<script lang="ts" generics="T">
  import { untrack, type Snippet } from "svelte";
  import { Search as MagnifyingGlassIcon } from "@lucide/svelte";
  import { cn } from "../../lib/utils";
  import PickerSkeletonRows from "./PickerSkeletonRows.svelte";

  let {
    open,
    warm = false,
    load,
    placeholder,
    title,
    centered = false,
    class: cardClass,
    onclose,
    children,
  }: {
    open: boolean;
    /** Mount before the first open, so that open only shows the dialog. */
    warm?: boolean;
    /** The dialog's lazy module. Called once, on the first open or warm. */
    load: () => Promise<{ default: T }>;
    /** The dialog's search placeholder, shown with a search icon. */
    placeholder?: string;
    /** The dialog's heading, for a dialog that opens on a form, not a search. */
    title?: string;
    /** Centre the card vertically, as the dialog does. */
    centered?: boolean;
    /** The dialog card's own size, so the dialog replaces the skeleton in place. */
    class?: string;
    /** Close the dialog from its skeleton or load error: a scrim click or Escape. */
    onclose: () => void;
    children: Snippet<[T]>;
  } = $props();

  // The dialog stays mounted after its first open, so its draft and focus
  // state survive a close.
  let hasMounted = $state(false);
  $effect(() => {
    if (open || warm) hasMounted = true;
  });
  const dialogModule = $derived(hasMounted ? untrack(load) : null);
</script>

<!-- While the module loads, the dialog's frame with placeholder rows, never a
     full-window wash. -->
{#snippet frame(body: Snippet)}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    data-solus-ui
    tabindex="-1"
    {@attach (el) => el.focus()}
    onclick={(e) => e.target === e.currentTarget && onclose()}
    onkeydown={(e) => e.key === "Escape" && onclose()}
    class={cn(
      "fixed inset-0 z-[10020] flex justify-center px-6 pointer-events-auto outline-none picker-backdrop",
      centered ? "items-center" : "items-start pt-[12vh]",
    )}
    role="presentation"
  >
    <div
      class={cn(
        "flex max-h-[min(30rem,66vh)] w-[clamp(22rem,56vw,38.75rem)] max-w-full flex-col overflow-hidden rounded-2xl border-[0.0625rem] border-(--solus-popover-border) bg-(--solus-popover-bg) shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.14),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.24)] [.dark_&]:shadow-[shadow:var(--solus-popover-shadow),inset_0_0.0625rem_0_rgba(255,255,255,0.06),0_1.75rem_3.125rem_-1.125rem_rgba(0,0,0,0.45)]",
        cardClass,
      )}
    >
      <div class="flex h-[3.3125rem] shrink-0 items-center gap-3 border-b border-(--solus-menu-hairline) px-5">
        {#if placeholder}
          <MagnifyingGlassIcon size={16} class="shrink-0 text-(--solus-text-tertiary) opacity-65" />
          <span class="truncate text-[length:calc(.875rem*var(--solus-font-scale,1))] text-(--solus-text-tertiary)">
            {placeholder}
          </span>
        {:else}
          <span class="truncate text-sm font-medium text-(--solus-text-primary)">{title}</span>
        {/if}
      </div>
      {@render body()}
    </div>
  </div>
{/snippet}

{#snippet loadFailed()}
  <p class="px-5 py-11 text-center text-sm text-(--solus-status-error)" role="alert">
    Couldn’t load this dialog. Reload the window, then try again.
  </p>
{/snippet}

{#if dialogModule}
  {#await dialogModule}
    {#if open}
      {@render frame(skeletonRows)}
    {/if}
  {:then loaded}
    {@render children(loaded.default)}
  {:catch}
    {#if open}
      {@render frame(loadFailed)}
    {/if}
  {/await}
{/if}

{#snippet skeletonRows()}
  <PickerSkeletonRows />
{/snippet}
