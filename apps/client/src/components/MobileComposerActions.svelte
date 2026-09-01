<script lang="ts">
  import { Plus as PlusIcon } from "@lucide/svelte";
  import MobileSessionSheet from "./MobileSessionSheet.svelte";
  import { mobileComposerMenu } from "../lib/mobile-composer-menu.svelte";

  interface Props {
    /** The composer these controls belong to — a started session's tab, or the
     *  id of the draft composing one. Handed to the sheets so they edit this
     *  composer's run. */
    sourceId?: string;
    /** Dot on the `+` when the session has work to review. A draft has none. */
    changedFilesCount?: number;
  }
  let { sourceId, changedFilesCount = 0 }: Props = $props();
</script>

<!--
  The phone's composer controls, in the one arrangement they have anywhere on
  the surface: a `+` that opens the Add-to-chat sheet, then the model — which
  names the model and opens everything the next turn runs on. A draft composer
  and a started session's dock render this same pair, so `+` means the sheet
  everywhere and never the OS file picker.
-->
<!-- The tap target grows the hit area to the 44px a thumb needs; the circle
     stays 36px so the pill does not turn into a row of buttons. -->
<button
  class="mobile-pill-plus pointer-coarse:tap-area"
  class:mobile-pill-plus--has-changes={changedFilesCount > 0}
  onclick={() => (mobileComposerMenu.open = true)}
  aria-label="More options"
>
  <PlusIcon size={14} />
  {#if changedFilesCount > 0}
    <span class="mobile-pill-plus-dot" aria-hidden="true"></span>
  {/if}
</button>
<MobileSessionSheet {sourceId} />

<style>
  .mobile-pill-plus {
    position: relative;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--solus-text-tertiary);
    cursor: pointer;
    flex-shrink: 0;
    transition:
      color 0.15s ease,
      background 0.15s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .mobile-pill-plus:active {
    background: var(--solus-surface-hover);
    color: var(--solus-text-primary);
  }

  .mobile-pill-plus--has-changes {
    color: var(--solus-accent);
  }

  .mobile-pill-plus-dot {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 624.9375rem;
    background: var(--solus-accent);
    box-shadow: 0 0 0.25rem rgba(217, 119, 87, 0.5);
    pointer-events: none;
  }
</style>
