<script lang="ts">
  import {
    RotateCw as RotateCwIcon,
    TriangleAlert as TriangleAlertIcon,
    ExternalLink as ExternalLinkIcon,
  } from "@lucide/svelte";
  import { Button } from "../button";
  import { cn } from "../../../lib/tw";
  import {
    VIDEO_PRELOAD_ROOT_MARGIN,
    shouldPauseWhenHidden,
    videoErrorOutcome,
    videoFirstFrameTime,
    videoPlaybackSource,
    videoPreload,
    videoResumeTime,
  } from "./video-player";

  interface Props {
    /** The URL to play. Null while it resolves. A new value for the same video
     *  (a renewed signed URL) keeps the playhead; key the player on the video's
     *  identity when it can show a different video. */
    src: string | null;
    /** Names the video for assistive technology and the download. */
    label: string;
    poster?: string;
    /** The source could not be resolved at all, so there is nothing to load. */
    sourceFailed?: boolean;
    /** Get a fresh source after a failure. Rejects when there still is none. */
    onRetry?: () => Promise<void>;
    class?: string;
  }

  let {
    src,
    label,
    poster,
    sourceFailed = false,
    onRetry,
    class: className,
  }: Props = $props();

  let videoEl = $state<HTMLVideoElement | null>(null);
  let isNearViewport = $state(false);
  let playingSrc = $state<string | null>(null);
  let failedSrc = $state<string | null>(null);
  let isRetrying = $state(false);
  let loadAttempt = $state(0);
  // Where the user left the playhead. Not reactive: only the next load reads it.
  let savedTime = 0;

  const currentSrc = $derived(videoPlaybackSource(src, playingSrc));
  const hasFailed = $derived(
    currentSrc === null ? sourceFailed : failedSrc === currentSrc,
  );

  // Near the viewport once is enough: a player that has loaded its header does
  // not need to watch its position any more.
  $effect(() => {
    const el = videoEl;
    if (!el || isNearViewport) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) isNearViewport = true;
      },
      { rootMargin: VIDEO_PRELOAD_ROOT_MARGIN },
    );
    observer.observe(el);
    return () => observer.disconnect();
  });

  $effect(() => {
    const el = videoEl;
    if (!el) return;
    const pauseWhenHidden = () => {
      const isFullscreen = !!document.fullscreenElement?.contains(el);
      if (shouldPauseWhenHidden(document.hidden, isFullscreen)) el.pause();
    };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      el.pause();
    };
  });

  // Solus tabs stay mounted with display:none. That does not send a document
  // visibility event. Observe only playing videos to pause hidden tabs without
  // keeping an observer for every video in the transcript.
  $effect(() => {
    const el = videoEl;
    if (!el || !playingSrc) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting) && !document.fullscreenElement?.contains(el)) {
        el.pause();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  });

  function handleLoadedMetadata() {
    const el = videoEl;
    if (!el) return;
    const resumeAt = videoResumeTime(savedTime, el.duration);
    const seekTo =
      resumeAt ??
      videoFirstFrameTime({
        autoplay: el.autoplay,
        paused: el.paused,
        seeking: el.seeking,
        currentTime: el.currentTime,
        duration: el.duration,
        playedLength: el.played.length,
      });
    if (seekTo === null) return;
    try {
      el.currentTime = seekTo;
    } catch {
      // A refused seek must leave the native Play control usable.
    }
  }

  function rememberPlayhead() {
    if (videoEl) savedTime = videoEl.currentTime;
  }

  function handlePause() {
    rememberPlayhead();
    playingSrc = null;
  }

  /** A finished video starts over next time, not at its last frame. */
  function handleEnded() {
    savedTime = 0;
    playingSrc = null;
  }

  function handleError() {
    rememberPlayhead();
    if (videoErrorOutcome(playingSrc, src) === "use-latest") playingSrc = null;
    else failedSrc = currentSrc;
  }

  async function retry() {
    if (isRetrying) return;
    isRetrying = true;
    try {
      await onRetry?.();
      playingSrc = null;
      failedSrc = null;
      loadAttempt += 1;
    } catch {
      // Still no source: the error state stays, with its Retry.
    } finally {
      isRetrying = false;
    }
  }
</script>

<!-- A span, so the player is valid where Markdown puts an image: inside a
     paragraph. Every state keeps the same 16:9 slot, so nothing below moves
     when the video loads, fails, or is retried. -->
<span class={cn("relative block w-full", className)}>
  {#if hasFailed}
    <span
      role="alert"
      class="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg border border-(--solus-surface-secondary) bg-(--solus-surface-primary) p-4 text-center text-sm text-(--solus-text-secondary)"
    >
      <span class="inline-flex max-w-full items-center gap-1.5">
        <TriangleAlertIcon size={14} aria-hidden="true" class="shrink-0" />
        <span class="truncate">Video unavailable{label ? ` · ${label}` : ""}</span>
      </span>
      <span class="flex flex-wrap items-center justify-center gap-2">
        {#if onRetry || src}
          <Button
            size="sm"
            variant="secondary"
            disabled={isRetrying}
            onclick={() => void retry()}
            class="pointer-coarse:h-11 pointer-coarse:px-4"
          >
            <RotateCwIcon aria-hidden="true" />
            {isRetrying ? "Retrying…" : "Retry"}
          </Button>
        {/if}
        {#if src}
          <Button
            size="sm"
            variant="ghost"
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            download={label || undefined}
            class="pointer-coarse:h-11 pointer-coarse:px-4"
          >
            <ExternalLinkIcon aria-hidden="true" />
            Open
          </Button>
        {/if}
      </span>
    </span>
  {:else if currentSrc}
    {#key loadAttempt}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={videoEl}
        src={currentSrc}
        {poster}
        aria-label={label || "Video"}
        controls
        playsinline
        preload={videoPreload(isNearViewport)}
        class="block aspect-video w-full rounded-lg bg-black object-contain"
        onloadedmetadata={handleLoadedMetadata}
        onplay={() => (playingSrc = currentSrc)}
        onpause={handlePause}
        onended={handleEnded}
        onseeked={rememberPlayhead}
        onerror={handleError}
      ></video>
    {/key}
  {:else}
    <span
      role="status"
      aria-label="Loading video"
      class="block aspect-video w-full rounded-lg bg-(--solus-surface-primary)"
    ></span>
  {/if}
</span>
