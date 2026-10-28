<script lang="ts">
  import type { Snippet } from "svelte";
  import ArrowSquareOutIcon from "@lucide/svelte/icons/external-link";
  import PlayIcon from "@lucide/svelte/icons/play";
  import { localApi } from "@solus/client-core/local-api";
  import VideoPlayer from "./video-player/VideoPlayer.svelte";
  import { formatVideoDuration, videoFirstFrameTime } from "./video-player/video-player";
  import { standaloneMarkdownMediaLink } from "../../lib/githubMarkdown";

  interface Props {
    raw?: string;
    /** The URL the player loads when it is not the link itself: a host's
     *  signed copy of private GitHub media. */
    playbackSrc?: string;
    children?: Snippet;
  }

  let { raw = "", playbackSrc, children }: Props = $props();
  const media = $derived(standaloneMarkdownMediaLink(raw));
  const src = $derived(playbackSrc ?? media?.href ?? "");
  const label = $derived(media ? `Video from ${media.provider}` : "Video");
  let dialog = $state<HTMLDialogElement>();
  let expanded = $state(false);
  let duration = $state<string | null>(null);

  function openMedia(event: MouseEvent) {
    if (!media) return;
    event.preventDefault();
    void localApi.openExternal(media.href);
  }

  function expand() {
    expanded = true;
    dialog?.showModal();
  }

  /** The poster is the video's own first frame: a muted, metadata-only load
   *  and a tiny seek. */
  function showFirstFrame(event: Event & { currentTarget: HTMLVideoElement }) {
    const el = event.currentTarget;
    duration = formatVideoDuration(el.duration);
    const seekTo = videoFirstFrameTime({
      autoplay: el.autoplay,
      paused: el.paused,
      seeking: el.seeking,
      currentTime: el.currentTime,
      duration: el.duration,
      playedLength: el.played.length,
    });
    if (seekTo !== null) el.currentTime = seekTo;
  }
</script>

{#if media}
  <div class="markdown-media-player my-3 flex flex-col gap-1.5">
    <!-- A click opens the video in the lightbox, as an attached video does. -->
    <button
      type="button"
      class="group relative block aspect-video w-full cursor-pointer overflow-hidden rounded-lg bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      aria-label="Play {label}{duration ? `, ${duration}` : ''}"
      onclick={expand}
    >
      {#key src}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          {src}
          muted
          playsinline
          preload="metadata"
          aria-hidden="true"
          tabindex="-1"
          class="pointer-events-none size-full object-contain"
          onloadedmetadata={showFirstFrame}
        ></video>
      {/key}
      <span class="absolute inset-0 flex items-center justify-center">
        <span class="flex size-12 items-center justify-center rounded-full bg-black/55 text-white transition-colors group-hover:bg-black/70">
          <PlayIcon size={20} fill="currentColor" aria-hidden="true" />
        </span>
      </span>
      {#if duration}
        <span class="absolute right-2 bottom-2 rounded bg-black/65 px-1.5 text-xs leading-5 text-white tabular-nums">
          {duration}
        </span>
      {/if}
    </button>
    <a
      href={media.href}
      class="markdown-media-link inline-flex w-fit items-center gap-1 text-xs text-(--solus-text-tertiary) transition-colors hover:text-(--solus-text-secondary)"
      onclick={openMedia}
    >
      Open on {media.provider}
      <ArrowSquareOutIcon size={11} aria-hidden="true" />
    </a>
  </div>
  <!-- A native modal: Escape closes it, focus returns to the poster, and it
       sits in the top layer above every pane. The player takes its own clicks,
       so only the backdrop closes it. Closing unmounts the player, which stops
       playback. -->
  <dialog
    bind:this={dialog}
    class="m-auto w-[min(90vw,64rem)] max-w-none overflow-visible bg-transparent p-0 outline-none backdrop:bg-black/70"
    aria-label={label}
    onclick={(event) => { if (event.target === dialog) dialog?.close(); }}
    onclose={() => (expanded = false)}
  >
    {#if expanded}
      {#key src}
        <VideoPlayer {src} {label} />
      {/key}
    {/if}
  </dialog>
{:else}
  <p>{@render children?.()}</p>
{/if}
