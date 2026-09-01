<script lang="ts">
  import {
    Check as CheckIcon,
    Clock as ClockIcon,
    FileText as FileTextIcon,
    MessageSquare as MessageIcon,
    Moon as MoonIcon,
    LoaderCircle as SpinnerIcon,
    CircleX as XCircleIcon,
  } from "@lucide/svelte";
  import type { MobileStateGlyph } from "../lib/mobile-task-row";

  interface Props {
    glyph: MobileStateGlyph;
    /** 15px in a task row's tile, 14px on a session row. */
    size?: number;
  }
  let { glyph, size = 15 }: Props = $props();
</script>

<!--
  One mark per state, in the caller's ink. The four the desktop sidebar draws
  keep their silhouettes exactly — a speech bubble asks, a page waits to be
  read, a crossed circle reports a run that died, a clock is the provider's
  problem — and the phone adds the three the sidebar spends elsewhere: a moon
  for snoozed, a check for finished with, and the sidebar's own unread disc.

  Idle draws a resting disc rather than nothing. The mark sits in a fixed slot
  the rows align on, and an empty slot on a phone reads as a mark that failed to
  load. It is the one glyph with no interior detail *and* no colour, which is
  what "nothing to report" should look like next to eight states that do.

  The rows that use this name their state in words on the control itself, so
  every glyph here is decoration to a screen reader.
-->
{#if glyph === "running"}
  <SpinnerIcon {size} class="animate-spin motion-reduce:animate-none" />
{:else if glyph === "question"}
  <MessageIcon {size} />
{:else if glyph === "plan"}
  <FileTextIcon {size} />
{:else if glyph === "failure"}
  <XCircleIcon {size} />
{:else if glyph === "limit"}
  <ClockIcon {size} />
{:else if glyph === "snoozed"}
  <MoonIcon {size} />
{:else if glyph === "completed"}
  <CheckIcon {size} />
{:else if glyph === "unread"}
  <span class="block rounded-full bg-current" style="width:{size * 0.45}px;height:{size * 0.45}px"
  ></span>
{:else}
  <span
    class="block rounded-full bg-current opacity-70"
    style="width:{size * 0.4}px;height:{size * 0.4}px"
  ></span>
{/if}
