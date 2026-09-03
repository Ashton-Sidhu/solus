<script lang="ts">
  import type { Snippet } from "svelte";
  import type { PrChecksSummary } from "@solus/contracts/checks-types";
  import type { PullRequest } from "@solus/contracts/providers";
  import { mergeReadiness } from "./lib/merge-readiness";
  import type { PrActionsLayout } from "./lib/pr-actions-layout";

  /**
   * Merge state as the bottom bar, for a pane too narrow to carry the rail
   * beside the conversation.
   *
   * On a wide pane the readiness card is the first thing in the right rail —
   * level with the title, always in view. Below the rail's rung there is no
   * column to hold it, and leaving it in a rail stacked under the reading
   * column would put the one thing you act on at the far end of every comment
   * on the pull request. So it comes back as a bar: the state, the blocker, and
   * the move that clears it, pinned where the composer sits everywhere else in
   * Solus.
   *
   * The bar is also the way back to everything else the rail was carrying —
   * reviewers, checks, changed files — through `details`. That is why it
   * renders for a `details` snippet alone: the bar is the folded layout's only
   * chrome, and a pull request whose readiness has not loaded yet must not be
   * a pull request whose reviewers are unreachable.
   *
   * It reads `mergeReadiness()` rather than being handed a verdict, which is
   * the same function the rail's card reads. Two renderings of one pure
   * function cannot drift into saying different things about one branch — the
   * "Conflicts with main / no conflicts" pair that model was written to kill.
   *
   * The blocked state says why once, here, and offers the fix. There is no
   * disabled Merge button with a tooltip explaining itself.
   */
  interface Props {
    detail: PullRequest | undefined;
    checks: PrChecksSummary | undefined;
    unresolvedCount: number;
    openedTime: string | null;
    /** The same actions the rail's card carries — merge, address comments —
     *  rendered in their row geometry rather than the card's stacked one. */
    actions?: Snippet<[PrActionsLayout]>;
    /** Opens the sheet holding the rail's reference sections. */
    details?: Snippet;
  }
  let {
    detail,
    checks,
    unresolvedCount,
    openedTime,
    actions,
    details,
  }: Props = $props();

  const readiness = $derived(
    detail
      ? mergeReadiness({ detail, checks, unresolvedCount, openedTime })
      : null,
  );
</script>

{#if readiness || details}
  <div
    class="flex shrink-0 items-center gap-3 border-t border-[var(--hairline-strong)] bg-card px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))] pointer-fine:[.is-laptop-display_&]:gap-2.5 pointer-fine:[.is-laptop-display_&]:px-3.5 pointer-fine:[.is-laptop-display_&]:py-2"
    role="status"
  >
    <!-- The text column is here even with nothing to say, so the trailing
         controls stay anchored right while the readiness is still loading. -->
    <span class="flex min-w-0 flex-1 flex-col">
      {#if readiness}
        <!-- The headline names the base branch a conflict is with, so it is the
             sentence rather than a status word. -->
        <span
          class="truncate font-semibold tracking-[-0.014em] {readiness.blocked
            ? 'text-[color-mix(in_oklch,var(--failure)_70%,var(--foreground))]'
            : ''}"
          title={readiness.headline}
        >
          {readiness.headline}
        </span>
        {#if readiness.note}
          <span
            class="truncate tabular-nums text-muted-foreground"
            title={readiness.note}
          >
            {readiness.note}
          </span>
        {/if}
      {/if}
    </span>

    {#if details}
      <span class="flex shrink-0 items-center">{@render details()}</span>
    {/if}
    <!-- The cluster may shrink; the merge control inside it may not. At the
         narrowest pane the bar can appear in there is not room for the
         readiness sentence, Details, the merge control and a second action all
         at full size, and the one that gives is the quiet one's label — not the
         decision the bar exists for, and not by spilling past the bar's edge. -->
    {#if actions}
      <span class="flex min-w-0 items-center">{@render actions("bar")}</span>
    {/if}
  </div>
{/if}
