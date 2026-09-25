<script lang="ts">
  import {
    X as XIcon,
    Play as PlayIcon,
    RotateCw as RotateCwIcon,
    Video as VideoIcon,
  } from "@lucide/svelte";
  import type { Attachment } from "@solus/contracts/types";
  import { HostMediaUrl, type HostMediaRequest } from "../../lib/host-media-url.svelte";
  import { videoAttachmentPath } from "../../lib/video-attachment";
  import { formatVideoDuration, videoFirstFrameTime } from "../ui/video-player/video-player";
  import { attachmentUploads } from "./lib/attachment-uploads.svelte";
  import { uploadProgressPercent } from "./lib/attachment-upload";

  interface Props {
    attachment: Attachment;
    label: string;
    /** Where the composer sends: the host a video without its own is on. */
    host: Pick<HostMediaRequest, "serverId" | "ctx" | "canReadLocalFiles">;
    onRemove: () => void;
    /** Play the video in the lightbox. */
    onPlay: (request: HostMediaRequest) => void;
  }

  let { attachment, label, host, onRemove, onPlay }: Props = $props();

  const upload = $derived(attachmentUploads.stateFor(attachment.id));
  const request = $derived.by((): HostMediaRequest | null => {
    if (upload) return null;
    const path = videoAttachmentPath(attachment);
    if (!path) return null;
    return {
      serverId: attachment.hostServerId ?? host.serverId,
      path,
      ctx: host.ctx,
      canReadLocalFiles: host.canReadLocalFiles,
    };
  });
  const media = new HostMediaUrl(() => request);
  let duration = $state<string | null>(null);

  /** The poster is the video's own first frame: a muted, metadata-only load
   *  and a tiny seek, instead of a generated thumbnail. */
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

<div class="relative size-14 flex-shrink-0 pointer-fine:[.is-laptop-display_&]:size-12">
  {#if upload?.status === "failed"}
    <!-- The whole tile retries: on a phone it is the only target large enough. -->
    <button
      type="button"
      onclick={() => attachmentUploads.retry(attachment.id)}
      title={upload.message}
      aria-label="Retry uploading {label}: {upload.message}"
      class="flex size-full flex-col items-center justify-center gap-0.5 rounded-lg border border-(--destructive)/40 bg-(--solus-surface-primary) text-(--destructive) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent) active:scale-[0.96] pointer-fine:[.is-laptop-display_&]:rounded-md"
    >
      <RotateCwIcon size={14} aria-hidden="true" />
      <span class="text-[0.625rem] font-medium">Retry</span>
    </button>
  {:else if upload?.status === "uploading"}
    {@const percent = uploadProgressPercent(upload.loadedBytes, upload.totalBytes)}
    <div
      role="progressbar"
      aria-label="Uploading {label}"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      class="relative flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border border-(--solus-container-border) bg-(--solus-surface-primary) text-(--solus-text-tertiary) pointer-fine:[.is-laptop-display_&]:rounded-md"
    >
      <VideoIcon size={14} aria-hidden="true" />
      <span class="text-[0.625rem] tabular-nums">{percent}%</span>
      <span
        class="absolute bottom-0 left-0 h-0.5 bg-(--solus-accent) transition-[width] duration-150 motion-reduce:transition-none"
        style="width:{percent}%"
      ></span>
    </div>
  {:else}
    <button
      type="button"
      onclick={() => request && onPlay(request)}
      disabled={!request}
      aria-label="Play {label}{duration ? `, ${duration}` : ''}"
      class="relative size-full overflow-hidden rounded-lg bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--solus-accent) pointer-fine:[.is-laptop-display_&]:rounded-md"
    >
      {#if media.url}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          src={media.url}
          muted
          playsinline
          preload="metadata"
          aria-hidden="true"
          tabindex="-1"
          class="pointer-events-none size-full object-cover"
          onloadedmetadata={showFirstFrame}
        ></video>
      {/if}
      <span class="absolute inset-0 flex items-center justify-center">
        <span class="flex size-6 items-center justify-center rounded-full bg-black/55 text-white">
          <PlayIcon size={11} fill="currentColor" aria-hidden="true" />
        </span>
      </span>
      {#if duration}
        <span class="absolute right-0.5 bottom-0.5 rounded bg-black/65 px-1 text-[0.5625rem] leading-3.5 text-white tabular-nums">
          {duration}
        </span>
      {/if}
    </button>
  {/if}

  <button
    type="button"
    onclick={() => {
      attachmentUploads.cancel(attachment.id);
      onRemove();
    }}
    aria-label="Remove {label}"
    class="absolute top-0 right-0 flex size-4 items-center justify-center rounded-full bg-black/60 text-white shadow-sm transition-[background-color,scale] duration-[var(--duration-quick)] hover:bg-black/80 focus-visible:bg-black/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.96] pointer-coarse:size-6 pointer-fine:[.is-laptop-display_&]:size-3.5"
  >
    <XIcon size={10} />
  </button>
</div>
