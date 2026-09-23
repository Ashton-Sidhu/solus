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
  // The browser follows the attachment URL itself. A
  // private repository's upload needs the reader's host session, which this
  // client does not have, so a failed load falls back to the link.
  let playbackFailedHref = $state<string | null>(null);
  const playbackFailed = $derived(!!media && playbackFailedHref === media.href);

  function openMedia(event: MouseEvent) {
    if (!media) return;
    event.preventDefault();
    void localApi.openExternal(media.href);
  }
</script>

{#if media && !playbackFailed}
  <!-- A video on its own line plays in place. `preload="metadata"` fetches
       only the header, enough for the first frame and the duration. -->
  <div class="markdown-media-player my-3 flex flex-col gap-1.5">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      src={media.href}
      controls
      playsinline
      preload="metadata"
      aria-label={`Video from ${media.provider}`}
      class="aspect-video max-h-[28rem] w-full rounded-[12px] border border-[var(--hairline-strong)] bg-black object-contain"
      onerror={() => (playbackFailedHref = media.href)}
    ></video>
    <a
      href={media.href}
      class="markdown-media-link inline-flex w-fit items-center gap-1 text-xs text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-secondary)"
      onclick={openMedia}
    >
      Open on {media.provider}
      <ArrowSquareOutIcon size={11} aria-hidden="true" />
    </a>
  </div>
{:else if media}
  <!-- Playback failed: a compact link chip, not a full-width banner. -->
  <p>
    <a
      href={media.href}
      class="markdown-media-link-card group inline-flex max-w-full cursor-pointer items-center gap-2.5 rounded-[12px] border border-[var(--hairline-strong)] bg-card py-1.5 pr-3 pl-1.5 text-left transition-[background-color,border-color] duration-(--duration-quick,120ms) ease-(--ease-premium,cubic-bezier(0.16,1,0.3,1)) hover:border-[var(--hairline-strongest)] hover:bg-(--solus-surface-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color-mix(in_srgb,var(--solus-accent)_45%,transparent)] motion-reduce:transition-none"
      onclick={openMedia}
      aria-label={`Watch video on ${media.provider}`}
    >
      <span
        class="grid size-7 shrink-0 place-items-center rounded-[8px] bg-[var(--wash-2)] text-(--solus-text-secondary) transition-colors group-hover:text-(--solus-text-primary)"
        aria-hidden="true"
      >
        <PlayIcon size={15} />
      </span>
      <span class="min-w-0 truncate font-medium text-(--solus-text-primary)">
        Watch on {media.provider}
      </span>
      <ArrowSquareOutIcon
        size={13}
        class="shrink-0 text-(--solus-text-tertiary) transition-colors group-hover:text-(--solus-text-secondary)"
        aria-hidden="true"
      />
    </a>
  </p>
{:else}
  <p>{@render children?.()}</p>
{/if}
