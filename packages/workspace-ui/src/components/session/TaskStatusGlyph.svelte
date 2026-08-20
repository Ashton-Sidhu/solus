<script lang="ts">
  import { fade } from "svelte/transition";
  import {
    MessageSquare as ChatTeardropIcon,
    Clock as ClockIcon,
    FileText as FileTextIcon,
    CircleX as XCircleIcon,
  } from "@lucide/svelte";
  import { hasGlyph, type TaskStatus } from "./lib/task-list";

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  interface Props {
    status: TaskStatus;
    label: string;
    /** 13.5px in the sidebar's margin, 13px on a session row. */
    size?: number;
  }
  let { status, label, size = 13.5 }: Props = $props();

  // Reserved colour, one meaning each: terracotta wants you, red has stopped,
  // amber is the provider's problem and not yours.
  const color = $derived(
    status === "error"
      ? "var(--destructive)"
      : status === "limit"
        ? "var(--chart-2)"
        : "var(--primary)",
  );

  // A speech bubble for a question — the agent asking you something, which no
  // punctuation mark conveys as directly — a page for a plan waiting to be read,
  // the same glyph the plan card itself carries, and a crossed circle for a run
  // that died: a triangle warns about what might happen, an X reports what did.
  // Same glyph per state as the breadcrumb, tab strip and project rail, which
  // all read from `sessionUtils`.
  const Glyph = $derived(
    status === "question"
      ? ChatTeardropIcon
      : status === "plan"
        ? FileTextIcon
        : status === "error"
          ? XCircleIcon
          : ClockIcon,
  );
</script>

<!--
  A mark, not a sentence. Two silhouettes scan faster down a column than two
  phrases and they cost no width as titles grow. Outline, in the same family as
  the nav icons — colour is what separates state from navigation here, and these
  are the one thing exempt from the list's focus falloff, so they stay at full
  contrast while everything around them steps back.
-->
{#if hasGlyph(status)}
  <span
    class="flex shrink-0 items-center"
    style:color
    role="img"
    aria-label={label}
  >
    <!-- A state change is the agent's doing, not the user's, so the swap fades
         rather than moves: no scale, no bounce, nothing that reads as motion
         out of the corner of an eye. -->
    {#key status}
      <span
        class="flex items-center"
        in:fade={{ duration: reduceMotion ? 0 : 120 }}
      >
        <Glyph {size} />
      </span>
    {/key}
  </span>
{/if}
