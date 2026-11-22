<script lang="ts">
  import type { InlineReviewGuide } from "@solus/contracts/inline-review-guide";
  import { resolveInlineReviewGuide, type ReadTurnDiff } from "@solus/client-core/inline-review-guide";
  import GuideView from "../pr-review/guide/GuideView.svelte";
  import { splitPatchByFile } from "../pr-review/guide/lib/guide-data";

  let { draft, read }: { draft: InlineReviewGuide; read?: ReadTurnDiff } = $props();
  let attempt = $state(0);
  const result = $derived.by(() => {
    void attempt;
    return resolveInlineReviewGuide(draft, read ?? (async () => null), splitPatchByFile);
  });
</script>

{#await result}
  <p role="status">Loading snapshot diffs…</p>
{:then value}
  {#if value.unavailable.length}
    <p role="status">Some files could not be loaded from turn {value.unavailable.join(", ")}.
      {#if read}<button class="underline" onclick={() => attempt++}>Retry</button>{/if}
    </p>
  {/if}
  <div class="not-prose flex h-[min(70vh,52rem)] min-w-0 flex-col overflow-hidden">
    <GuideView guide={value.guide} patch="" />
  </div>
{/await}
