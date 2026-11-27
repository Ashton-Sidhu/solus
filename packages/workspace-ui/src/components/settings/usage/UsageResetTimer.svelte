<script lang="ts">
  import { formatLiveResetCountdown } from "@solus/client-core/usage-limits";
  import { liveActivityClock } from "../../../lib/shared-clock";

  interface Props {
    resetsAt: number | null;
    resetsLabel?: string | null;
    verb?: string;
    compact?: boolean;
    class?: string;
    title?: string;
  }

  let {
    resetsAt,
    resetsLabel = null,
    verb = "resets",
    compact = false,
    class: className = "",
    title,
  }: Props = $props();

  let now = $state(Date.now());

  // Tick only this leaf text node on the shared 1s clock (which auto-pauses
  // while the page is hidden) so parent charts and models do not recompute.
  $effect(() => {
    if (resetsAt === null || !Number.isFinite(resetsAt)) return;
    return liveActivityClock.subscribe((value) => {
      now = value;
    });
  });

  const text = $derived(
    formatLiveResetCountdown(resetsAt, resetsLabel, now, { verb, compact }),
  );
</script>

{#if text}
  <span class="tabular-nums {className}" {title}>{text}</span>
{/if}
