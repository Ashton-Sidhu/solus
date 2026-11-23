<script lang="ts">
  import { untrack } from "svelte";
  import type { InlineReviewGuide } from "@solus/contracts/inline-review-guide";
  import { loadInlineReviewGuide, type ReadTurnDiff } from "@solus/client-core/inline-review-guide";
  import GuideView from "../pr-review/guide/GuideView.svelte";
  import { splitPatchByFile } from "../pr-review/guide/lib/guide-data";

  let { draft, read }: { draft: InlineReviewGuide; read?: ReadTurnDiff } = $props();
  const offline: ReadTurnDiff = async () => null;
  let retryCount = $state(0);
  const result = $derived.by(() => {
    const reader = read ?? offline;
    const guide = draft;
    void retryCount;
    const entry = untrack(() => loadInlineReviewGuide(guide, reader, splitPatchByFile));
    return entry.value ?? entry.ready;
  });

  function retry() {
    if (read) loadInlineReviewGuide(draft, read, splitPatchByFile, true);
    retryCount++;
  }
</script>

{#await result}
  <p role="status">Loading snapshot diffs…</p>
{:then value}
  {#if value.unavailable.length}
    <p role="status">Could not read the snapshot for turn {value.unavailable.join(", ")}.
      {#if read}<button class="underline" onclick={retry}>Retry</button>{/if}
    </p>
  {/if}
  <GuideView guide={value.guide} patch="" />
{/await}
