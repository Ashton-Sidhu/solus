<script lang="ts">
  import UnifiedAutocompleteMenu from "../input/UnifiedAutocompleteMenu.svelte";
  import type { MentionPicker } from "./lib/mention-picker.svelte";

  // The people picker draws in the reference menu's popover, so `@` looks and
  // moves the same in a comment, a work body and the prompt. At phone width the
  // popover spans the window, as it does for the prompt's picker. It opens
  // toward the larger half of the window: a composer pinned to the foot of a
  // page opens up, a thread card in the margin opens down.
  let { picker }: { picker: MentionPicker } = $props();
  const placement = $derived(
    picker.anchorRect && picker.anchorRect.top > window.innerHeight / 2 ? "up" : "down",
  );
</script>

{#if picker.open}
  <UnifiedAutocompleteMenu
    rows={picker.rows}
    triggerChar="@"
    selectedIndex={picker.selectedIndex}
    anchorRect={picker.anchorRect}
    onActivate={picker.activate}
    onHover={(index) => picker.hoverRow(index)}
    onBack={picker.dismiss}
    enterVerb="insert"
    tabVerb="insert"
    showTabHint={false}
    footer=""
    sessionPreview=""
    {placement}
    onDismiss={picker.dismiss}
  />
{/if}
