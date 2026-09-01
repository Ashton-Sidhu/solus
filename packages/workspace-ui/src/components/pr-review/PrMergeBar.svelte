<script lang="ts">
  import type { Snippet } from "svelte";
  import type { PrChecksSummary } from "@solus/contracts/checks-types";
  import type { PullRequest } from "@solus/contracts/providers";
  import { mergeReadiness } from "./lib/merge-readiness";

  /**
   * Merge state as the bottom bar, for a pane too narrow to carry the rail
   * beside the conversation.
   *
   * On a wide pane the readiness card is the first thing in the right rail —
   * level with the title, always in view. Below 30rem that rail folds *under*
   * the reading column, which puts the one thing you act on at the far end of
   * every comment on the pull request. So it comes back as a bar: the state,
   * the blocker, and the move that clears it, pinned where the composer sits
   * everywhere else in Solus.
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
    /** The same actions the rail's card carries — merge, address comments. */
    actions?: Snippet;
  }
  let { detail, checks, unresolvedCount, openedTime, actions }: Props = $props();

  const readiness = $derived(
    detail
      ? mergeReadiness({ detail, checks, unresolvedCount, openedTime })
      : null,
  );
</script>

{#if readiness}
  <div
    class="flex shrink-0 items-center gap-3 border-t border-[var(--hairline-strong)] bg-card px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom,0px))]"
    role="status"
  >
    <span class="flex min-w-0 flex-1 flex-col">
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
    </span>

    {#if actions}
      <span class="flex shrink-0 items-center gap-1.5">{@render actions()}</span>
    {/if}
  </div>
{/if}
