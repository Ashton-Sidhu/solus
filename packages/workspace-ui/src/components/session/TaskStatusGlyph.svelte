<script lang="ts">
  import { fade } from "svelte/transition";
  import {
    MessageCircleQuestionMark as InputIcon,
    ShieldAlert as ApprovalIcon,
    Clock as ClockIcon,
    FileText as FileTextIcon,
    CircleX as XCircleIcon,
    CircleCheck as CheckCircleIcon,
  } from "@lucide/svelte";
  import { formatResetClock } from "../../lib/sessionUtils";
  import { glyphWord, isGlyphStatus, type GlyphStatus, type TaskStatus } from "./lib/task-list";

  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  interface Props {
    /** A status with no line glyph (running, idle, done) draws nothing. */
    status: TaskStatus | GlyphStatus;
    label: string;
    /** 13.5px in the sidebar's margin, 13px on a session row. */
    size?: number;
    /** Input, Approval, and Limited say their word beside the glyph. A
     *  stack of several marks leaves it out. */
    showsWord?: boolean;
    /** While limited: when the provider window reopens, in epoch ms. */
    limitResetsAt?: number | null;
  }
  let { status, label, size = 13.5, showsWord = true, limitResetsAt = null }: Props = $props();

  // Reserved colour, one meaning each: terracotta wants you, red has stopped,
  // amber is the provider's problem and not yours, and the complete tone is
  // finished work.
  const color = $derived(
    status === "error"
      ? "var(--destructive)"
      : status === "limit"
        ? "var(--warning)"
        : status === "finished"
          ? "var(--solus-status-complete)"
          : "var(--primary)",
  );

  // A bubble with a question mark for a question — the agent asking you
  // something — a shield with an exclamation for a permission it asks for, a
  // page for a plan waiting to be read, the same glyph the plan card itself
  // carries, a crossed circle for a run that died: a triangle warns about
  // what might happen, an X reports what did, and a checked circle for
  // finished work you have not read. Same glyph per state as the breadcrumb,
  // tab strip and project rail, which all read from `sessionUtils`.
  const Glyph = $derived(
    status === "question"
      ? InputIcon
      : status === "approval"
        ? ApprovalIcon
        : status === "plan"
          ? FileTextIcon
          : status === "error"
            ? XCircleIcon
            : status === "finished"
              ? CheckCircleIcon
              : ClockIcon,
  );
  const word = $derived(showsWord && isGlyphStatus(status) ? glyphWord(status) : null);
  const resetClock = $derived(
    word && status === "limit" && limitResetsAt ? formatResetClock(limitResetsAt) : null,
  );
</script>

<!--
  A mark, and for three states one word. A silhouette scans faster down a
  column than a phrase and costs no width as titles grow, so Plan, Failed, and
  Done stay glyph only. Input, Approval, and Limited add one word
  (docs/plans/session-state-marks.md, "three line glyphs carry a word"): the
  question bubble and the permission shield read alike at 13px, and Limited
  needs its reset time. The full sentence stays in `aria-label` and the
  tooltip. Outline, in the same family as the nav icons — colour is what
  separates state from navigation here, and these are the one thing exempt
  from the list's focus falloff, so they stay at full contrast while
  everything around them steps back.
-->
{#if isGlyphStatus(status)}
  <span
    class="flex shrink-0 items-center gap-1"
    style:color
    role="img"
    aria-label={label}
  >
    <!-- A state change is the agent's doing, not the user's, so the swap fades
         rather than moves: no scale, no bounce, nothing that reads as motion
         out of the corner of an eye. -->
    {#key status}
      <span
        class="flex items-center gap-1"
        in:fade={{ duration: reduceMotion ? 0 : 120 }}
      >
        <Glyph {size} />
        {#if word}
          <span class="text-xs leading-none font-semibold whitespace-nowrap" aria-hidden="true">{word}</span>
        {/if}
        {#if resetClock}
          <span class="text-xs leading-none font-normal whitespace-nowrap tabular-nums text-muted-foreground" aria-hidden="true">{resetClock}</span>
        {/if}
      </span>
    {/key}
  </span>
{/if}
