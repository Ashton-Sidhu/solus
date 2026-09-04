<script lang="ts">
  import type { Snippet } from "svelte";
  import PlayIcon from "@lucide/svelte/icons/circle-play";
  import ArrowSquareOutIcon from "@lucide/svelte/icons/external-link";
  import { localApi } from "@solus/client-core/local-api";
  import { standaloneMarkdownMediaLink } from "../../lib/githubMarkdown";

  interface Props {
    raw?: string;
    children?: Snippet;
  }

  let { raw = "", children }: Props = $props();
  const media = $derived(standaloneMarkdownMediaLink(raw));

  function openMedia(event: MouseEvent) {
    if (!media) return;
    event.preventDefault();
    void localApi.openExternal(media.href);
  }
</script>

{#if media}
  <p>
    <a
      href={media.href}
      class="markdown-media-link-card group flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-xl border border-(--solus-container-border) bg-card px-3.5 py-3 text-left transition-[background-color,border-color,transform] duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) hover:border-foreground/20 hover:bg-(--solus-surface-hover) active:scale-[0.995] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] motion-reduce:transition-none"
      onclick={openMedia}
      aria-label={`Watch video on ${media.provider}`}
    >
      <span
        class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--solus-surface-hover) text-(--solus-text-secondary) transition-colors group-hover:text-(--solus-text-primary)"
        aria-hidden="true"
      >
        <PlayIcon size={16} />
      </span>
      <span class="min-w-0 flex-1 font-medium text-(--solus-text-primary)">
        Watch on {media.provider}
      </span>
      <ArrowSquareOutIcon
        size={14}
        class="shrink-0 text-(--solus-text-tertiary) transition-colors group-hover:text-(--solus-text-secondary)"
        aria-hidden="true"
      />
    </a>
  </p>
{:else}
  <p>{@render children?.()}</p>
{/if}
