<script lang="ts">
  import FrameExpandButton from "../layout/FrameExpandButton.svelte";
  import { Skeleton } from "../ui/skeleton";

  // The placeholder shown while a clicked PR's worktree is being fetched/checked
  // out, before PrReviewPane can mount. Mirrors that pane's chrome (tabs +
  // #number · title) and the Activity tab's skeleton body so the real surface
  // swaps in without a layout jump. Static — no interactions until it's ready.
  let { number, title }: { number: number; title?: string } = $props();

  const TABS = ["Activity", "Guide", "Diff"];
</script>

<section class="flex h-full min-h-0 flex-col bg-(--solus-container-bg)">
  <header
    class="flex h-[var(--solus-chrome-row-h,2.5rem)] shrink-0 items-center gap-2 border-b border-[color:var(--solus-chrome-row-border,color-mix(in_srgb,var(--solus-container-border)_50%,transparent))] pr-2 pl-[max(0.75rem,var(--solus-chrome-lead-inset,0px))]"
  >
    <FrameExpandButton variant="sidebar" />

    <!-- Mirrors PrReviewPane's shadcn Tabs bar. -->
    <div
      class="inline-flex items-center gap-0.5 rounded-lg bg-(--solus-accent-light) p-0.5"
      aria-hidden="true"
    >
      {#each TABS as t, i (t)}
        <span
          class={`rounded-md px-2.5 py-1 text-xs font-medium ${i === 0 ? "bg-(--solus-container-bg) text-(--solus-text-primary) shadow-sm" : "text-(--solus-text-tertiary)"}`}
        >
          {t}
        </span>
      {/each}
    </div>

    <div class="flex min-w-0 flex-1 items-center text-xs text-(--solus-text-tertiary)">
      <span class="shrink-0 font-semibold text-(--solus-text-secondary)">#{number}</span>
      {#if title}
        <span class="px-1">·</span>
        <span class="truncate">{title}</span>
      {/if}
    </div>
  </header>

  <!-- Mirrors ActivityFeed's loading skeleton (title · meta · description ·
       timeline · right rail) so content fills in without a jump. -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="mx-auto flex w-full max-w-[70rem] gap-10 px-8 py-9">
      <main class="flex min-w-0 flex-1 flex-col">
        <Skeleton class="h-7 w-2/3 bg-(--solus-art-border)" />
        <div class="mt-4 flex items-center gap-2">
          <Skeleton class="size-5 rounded-full bg-(--solus-art-border)" />
          <Skeleton class="h-3 w-24 rounded bg-(--solus-art-border)" />
          <Skeleton class="h-3 w-32 rounded bg-(--solus-art-border)" />
        </div>
        <div class="mt-8 flex flex-col gap-2.5">
          <Skeleton class="h-3 w-full rounded bg-(--solus-art-border)" />
          <Skeleton class="h-3 w-11/12 rounded bg-(--solus-art-border)" />
          <Skeleton class="h-3 w-3/4 rounded bg-(--solus-art-border)" />
        </div>
        <Skeleton class="mt-10 h-3 w-20 rounded bg-(--solus-art-border)" />
        <div class="mt-4 flex flex-col gap-3">
          <Skeleton class="h-20 rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)" />
          <Skeleton class="h-20 rounded-xl border border-(--solus-art-border) bg-(--solus-art-surface)" />
        </div>
      </main>

      <aside class="hidden w-[16.5rem] shrink-0 flex-col gap-3.5 lg:flex">
        <Skeleton class="h-28 rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)" />
        <Skeleton class="h-48 rounded-2xl border border-(--solus-art-border) bg-(--solus-art-surface)" />
      </aside>
    </div>
  </div>
</section>
