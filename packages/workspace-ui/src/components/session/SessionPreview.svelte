<script lang="ts">
  import { MessageCircle as ChatCircleIcon, ArrowRight as ArrowRightIcon } from "@lucide/svelte";
  import type { PreviewExtraction } from "../../lib/sessionPreviewMessages";
  import { highlightRuns } from "../../lib/searchHighlight";
  import { Skeleton } from "../ui/skeleton";

  interface Props {
    preview: PreviewExtraction | null;
    loading: boolean;
    title?: string;
    byline?: string;
    timeAgo?: string | null;
    hiddenCount?: number;
    /** The picker's live search term. The row only shows a truncated title, so
     *  a query can match deep in the first message with nothing marked in the
     *  list — the preview is where that match becomes visible. */
    query?: string;
    onContinue?: () => void;
  }
  let {
    preview,
    loading,
    title = "",
    byline = "",
    timeAgo = null,
    hiddenCount = 0,
    query = "",
    onContinue,
  }: Props = $props();

  const hasSession = $derived(!!preview || loading);

  const titleRuns = $derived(highlightRuns(title, query));
  const bylineRuns = $derived(highlightRuns(byline, query));
  const firstMessageRuns = $derived(
    highlightRuns(preview?.firstUserMessage?.snippet ?? "", query),
  );
</script>

<div class="text-xs flex h-full min-w-0 flex-col">
  {#if hasSession && title}
    <div class="flex min-w-0 flex-shrink-0 items-center gap-3 px-[1.125rem] pb-2.5 pt-3">
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          class="overflow-hidden text-ellipsis whitespace-nowrap font-medium leading-[1.3] text-[var(--solus-text-primary)]"
          title={title}
        >{#each titleRuns as run, i (i)}{#if run.hit}<mark
              class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
              >{run.text}</mark
            >{:else}{run.text}{/if}{/each}</div>
        <div class="flex min-w-0 items-center gap-1.5 text-[var(--solus-text-tertiary)]">
          {#if byline}<span
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
              >{#each bylineRuns as run, i (i)}{#if run.hit}<mark
                    class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
                    >{run.text}</mark
                  >{:else}{run.text}{/if}{/each}</span
            >{/if}
          {#if byline && timeAgo}<span class="flex-shrink-0 opacity-50">·</span
            >{/if}
          {#if timeAgo}<span
              class="flex-shrink-0 opacity-80 [font-variant-numeric:tabular-nums]"
              >{timeAgo}</span
            >{/if}
        </div>
      </div>
      {#if onContinue && preview}
        <button
          class="inline-flex min-h-8 flex-shrink-0 cursor-pointer items-center gap-[0.3125rem] rounded-lg bg-card px-[0.5625rem] py-[0.1875rem] font-medium text-(--solus-text-secondary) shadow-[shadow:var(--solus-tx-hairline)] transition-[background-color,color,transform] duration-150 hover:translate-x-[0.0625rem] hover:bg-(--solus-surface-hover) hover:text-(--solus-text-primary) active:scale-[0.96] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--solus-accent-border-medium)"
          onclick={onContinue}
        >
          <span>Continue</span>
          <ArrowRightIcon size={10} />
        </button>
      {/if}
    </div>
  {/if}

  {#if !preview && !loading}
    <div class="flex h-full flex-col items-center justify-center gap-2.5">
      <ChatCircleIcon size={26} class="text-(--solus-text-muted) opacity-35" />
      <span class="text-xs text-[var(--solus-text-tertiary)]"
        >Select a session to preview</span
      >
    </div>
  {:else if loading}
    <div class="flex flex-1 flex-col gap-3 overflow-y-auto px-[1.125rem] pb-4 pt-1">
      <Skeleton class="ml-auto h-8 w-[62%] rounded-2xl" />
      <div class="flex flex-col gap-2 py-2">
        <Skeleton class="h-3 w-[82%] rounded-[0.375rem]" />
        <Skeleton class="h-3 w-[68%] rounded-[0.375rem]" />
      </div>
      <Skeleton class="ml-auto h-8 w-[48%] rounded-2xl" />
    </div>
  {:else}
    <div class="flex flex-1 flex-col overflow-y-auto px-[1.125rem] pb-4 pt-0.5">
      {#if preview?.firstUserMessage}
        <div class="flex justify-end pb-1.5 pt-3">
          <span
            class="prose-transcript-user max-w-[88%] overflow-hidden break-words rounded-2xl bg-[color-mix(in_oklch,var(--foreground)_2%,transparent)] px-3 py-2.5 text-(--solus-text-primary)"
            >{#each firstMessageRuns as run, i (i)}{#if run.hit}<mark
                  class="rounded-[0.1875rem] bg-[color-mix(in_oklch,var(--primary)_22%,transparent)] px-px text-inherit"
                  >{run.text}</mark
                >{:else}{run.text}{/if}{/each}</span
          >
        </div>
      {/if}

      {#if preview?.lastAssistantMessage}
        <div
          class="my-2 flex items-center gap-2.5 before:h-px before:flex-1 before:bg-[var(--solus-tx-rule)] before:content-[''] after:h-px after:flex-1 after:bg-[var(--solus-tx-rule)] after:content-['']"
        >
          <span
            class="whitespace-nowrap uppercase text-(--solus-text-tertiary)"
            >{hiddenCount > 0
              ? `+${hiddenCount} more · last reply`
              : "last reply"}</span
          >
        </div>
        <div class="w-full overflow-hidden whitespace-pre-wrap break-words py-2">
          <div class="prose-cloud prose-reading prose-transcript min-w-0">
            {preview.lastAssistantMessage.snippet}
          </div>
        </div>
      {:else if !preview?.firstUserMessage}
        <div class="flex h-full flex-col items-center justify-center gap-2.5 pt-10">
          <span class="text-xs text-[var(--solus-text-tertiary)]"
            >No messages</span
          >
        </div>
      {/if}
    </div>
  {/if}
</div>
