<script lang="ts">
  import type { DiffComment } from "../../../shared/types";
  import type { GuideDiffCommentSave } from "../pr-review/guide/lib/guide-data";
  import GuideView from "../pr-review/guide/GuideView.svelte";
  import ReviewProgress from "./ReviewProgress.svelte";
  import type { GuideLoader } from "./lib/guide-loader.svelte";

  // Presentation for a loaded guide: stepped progress while loading (cache read
  // or generation), the native GuideView once data is ready, or an empty note.
  // Owns no chrome and no data loading — the host supplies the loader.
  let {
    loader,
    meta,
    onFileJump,
    comments = [],
    onCommentSave,
    onCommentDelete,
  }: {
    loader: GuideLoader;
    /** PR identity for the guide's intro header; absent for local-branch reviews. */
    meta?: { repo?: string; number?: number; baseRef: string; branch: string };
    /** Routed to GuideView so file chips can switch a host's Diff tab. */
    onFileJump?: (path: string) => void;
    /** Review-draft comments + handlers for inline guide comments; absent
     *  (read-only) for the standalone local-branch view. */
    comments?: DiffComment[];
    onCommentSave?: (comment: GuideDiffCommentSave) => void;
    onCommentDelete?: (id: string) => void;
  } = $props();
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
  {#if loader.loading && loader.guide === null}
    <ReviewProgress step={loader.progressStep} />
  {:else if loader.guide && loader.guide.sections.length > 0}
    <GuideView
      guide={loader.guide}
      ledger={loader.ledger}
      patch={loader.patch}
      {meta}
      {onFileJump}
      {comments}
      {onCommentSave}
      {onCommentDelete}
    />
  {:else}
    <p class="px-5 py-8 text-center text-[0.8125rem] text-(--solus-text-tertiary)">
      {loader.guide?.summary ?? "No review guide for this branch yet."}
    </p>
  {/if}
</div>
