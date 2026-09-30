<script lang="ts">
  import {
    Activity as ActivityIcon,
    Check as CheckIcon,
    Clock as ClockIcon,
    FileText as FileTextIcon,
    MessageSquare as MessageIcon,
    Moon as MoonIcon,
    LoaderCircle as SpinnerIcon,
    CircleX as XCircleIcon,
  } from "@lucide/svelte";
  import type { MobileStateGlyph } from "./lib/mobile-task-row";

  interface Props {
    glyph: MobileStateGlyph;
    /** 15px in a task row's tile, 14px on a session row. */
    size?: number;
  }
  let { glyph, size = 15 }: Props = $props();
</script>

{#if glyph === "running"}
  <SpinnerIcon {size} class="animate-spin motion-reduce:animate-none" />
{:else if glyph === "background"}
  <ActivityIcon {size} />
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
  <!-- The sidebar's unread ring: dashed, drawn in the tile's ink. -->
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle
      cx="8"
      cy="8"
      r="6"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      pathLength="24"
      stroke-dasharray="1.6 1.4"
    />
  </svg>
{:else}
  <span
    class="block rounded-full bg-current opacity-70"
    style="width:{size * 0.4}px;height:{size * 0.4}px"
  ></span>
{/if}
