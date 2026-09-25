<script lang="ts">
  import type { Snippet } from "svelte";
  import ArrowSquareOutIcon from "@lucide/svelte/icons/external-link";
  import { localApi } from "@solus/client-core/local-api";
  import VideoPlayer from "./video-player/VideoPlayer.svelte";
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
  <div class="markdown-media-player my-3 flex flex-col gap-1.5">
    {#key media.href}
      <VideoPlayer src={media.href} label={`Video from ${media.provider}`} />
    {/key}
    <a
      href={media.href}
      class="markdown-media-link inline-flex w-fit items-center gap-1 text-xs text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-secondary)"
      onclick={openMedia}
    >
      Open on {media.provider}
      <ArrowSquareOutIcon size={11} aria-hidden="true" />
    </a>
  </div>
{:else}
  <p>{@render children?.()}</p>
{/if}
