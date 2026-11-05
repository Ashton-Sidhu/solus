<script lang="ts">
  import ChevronDownIcon from "@lucide/svelte/icons/chevron-down";
  import Maximize2Icon from "@lucide/svelte/icons/maximize-2";
  import { Button } from "../button/index.js";
  import { toastMessageDialog } from "./toast-message.svelte";

  /** A toast's description on one line. A click on it or on the button shows
   *  the full text: a long message in the toast message dialog, a cut-off short
   *  one in the toast (the toast service's `onExpand`). */
  let {
    title,
    text,
    opensDialog,
    onExpand,
  }: { title: string; text: string; opensDialog: boolean; onExpand: () => void } = $props();

  let line = $state<HTMLSpanElement>();
  let isTruncated = $state(false);
  const canExpand = $derived(opensDialog || isTruncated);

  function expand() {
    if (opensDialog) toastMessageDialog.open({ title, text });
    else onExpand();
  }

  // Truncation is a fact of the painted line, so it can only be measured.
  $effect(() => {
    if (line) isTruncated = line.scrollWidth > line.clientWidth;
  });
</script>

<div class="flex min-w-0 items-center gap-1">
  <!-- The button is the keyboard way in; the line is the larger pointer target. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <span
    bind:this={line}
    class={["min-w-0 truncate", canExpand && "cursor-pointer"]}
    onclick={canExpand ? expand : undefined}>{text}</span
  >
  {#if canExpand}
    <Button
      variant="ghost"
      size="icon-xs"
      class="-my-1 shrink-0 text-muted-foreground"
      aria-label="Show the full message"
      aria-haspopup={opensDialog ? "dialog" : undefined}
      title="Show the full message"
      onclick={expand}
    >
      <!-- Sonner starts a swipe unless the pointer lands on the button itself. -->
      {#if opensDialog}
        <Maximize2Icon class="pointer-events-none" />
      {:else}
        <ChevronDownIcon class="pointer-events-none" />
      {/if}
    </Button>
  {/if}
</div>
