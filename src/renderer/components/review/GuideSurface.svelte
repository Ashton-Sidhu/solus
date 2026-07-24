<script lang="ts">
  import { ArrowsClockwiseIcon } from "phosphor-svelte";
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
    /** Review-draft comments + handlers for inline guide comments. */
    comments?: DiffComment[];
    onCommentSave?: (comment: GuideDiffCommentSave) => void;
    onCommentDelete?: (id: string) => void;
  } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden">
  {#if loader.loading && loader.guide !== null}
    <!-- Regenerating over an existing guide: the old guide stays readable below,
         but say so — silence here reads as a dead Regenerate button. -->
    <div
      class="sticky top-0 z-10 flex items-center gap-2 border-b border-(--solus-art-border) bg-(--solus-container-bg) px-4 py-2 text-[0.75rem] text-(--solus-text-secondary)"
    >
      <ArrowsClockwiseIcon size={13} class="animate-spin [animation-duration:1.2s]" />
      Regenerating review guide…
    </div>
  {:else if loader.stale && loader.guide}
    <div
      class="sticky top-0 z-10 flex items-center gap-2.5 border-b border-[color:color-mix(in_srgb,var(--solus-accent)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--solus-accent)_12%,var(--solus-container-bg))] px-4 py-2 text-[0.75rem] text-(--solus-text-secondary)"
      role="status"
    >
      <span class="min-w-0 flex-1 truncate">
        The change has new commits since this guide was written.
      </span>
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[0.6875rem] font-medium text-(--solus-text-primary) transition-colors hover:bg-(--solus-surface-hover)"
        onclick={() => loader.refresh()}
      >
        <ArrowsClockwiseIcon size={11} weight="bold" />
        Regenerate
      </button>
    </div>
  {/if}
  {#if loader.loading && loader.guide === null}
    <ReviewProgress step={loader.progressStep} />
  {:else if loader.guide && loader.guide.sections.length > 0}
    <GuideView
      guide={loader.guide}
      ledger={loader.ledger}
      patch={loader.patch}
      fileVersions={loader.fileVersions}
      {meta}
      guideCurrent={!loader.stale}
      {onFileJump}
      {comments}
      {onCommentSave}
      {onCommentDelete}
    />
  {:else}
    <div class="grid min-h-48 place-items-center px-5 py-8 text-center">
      <div class="flex max-w-sm flex-col items-center">
        <p class="text-[0.8125rem] text-pretty text-(--solus-text-tertiary)">
          {loader.guide?.summary ?? "No review guide for this branch yet."}
        </p>
        <button
          type="button"
          class="mt-3 inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg bg-(--solus-accent-light) px-3 text-xs font-semibold text-(--solus-accent) transition-[background-color,scale] duration-150 hover:bg-[color-mix(in_srgb,var(--solus-accent-light)_100%,var(--solus-accent)_14%)] active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_50%,transparent)]"
          onclick={() => loader.refresh()}
        >
          <ArrowsClockwiseIcon size={13} weight="bold" />
          Generate guide
        </button>
      </div>
    </div>
  {/if}
</div>
