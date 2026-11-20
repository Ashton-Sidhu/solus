<script lang="ts">
  import { Pause, Play } from "@lucide/svelte";
  import type { ToolResultAudio } from "@solus/contracts/types";
  import { HostMediaUrl } from "../../lib/host-media-url.svelte";
  import { Button } from "../ui/button";
  import { getMarkdownImageContext } from "./lib/markdown-image";
  import { audioPlayedFraction, audioSeekForKey, audioSeekForPointer, formatAudioTime } from "@solus/client-core/tool-audio";

  /**
   * One audio clip of a tool result, in the Solus style: play and pause, the
   * time, and a seek bar like the tool row's progress bar. The element plays
   * it and has no controls of its own.
   */
  let { audio, label }: { audio: ToolResultAudio; label: string } = $props();
  const context = getMarkdownImageContext();
  const media = new HostMediaUrl(() => {
    const serverId = context?.serverId();
    return serverId ? { serverId, assetId: audio.assetId, ctx: context?.ctx() } : null;
  });
  let playbackFailed = $state(false);
  let hasRetried = false;
  let player = $state<HTMLAudioElement | null>(null);
  let isPlaying = $state(false);
  let current = $state(0);
  let duration = $state(0);
  let isSeeking = false;
  const fraction = $derived(audioPlayedFraction(current, duration));

  /** A signed URL can expire while the row is open: mint one new URL, then give up. */
  async function recover() {
    if (hasRetried) {
      playbackFailed = true;
      return;
    }
    hasRetried = true;
    await media.retry().catch(() => (playbackFailed = true));
  }

  function readTimes() {
    if (!player) return;
    current = player.currentTime;
    duration = Number.isFinite(player.duration) ? player.duration : 0;
  }

  function toggle() {
    if (!player) return;
    if (player.paused) void player.play().catch(() => {});
    else player.pause();
  }

  function seek(to: number) {
    if (!player) return;
    player.currentTime = to;
    current = to;
  }

  function seekKey(event: KeyboardEvent) {
    if (event.key === " ") {
      event.preventDefault();
      toggle();
      return;
    }
    const to = audioSeekForKey(event.key, current, duration);
    if (to === null) return;
    event.preventDefault();
    seek(to);
  }

  function seekPointer(event: PointerEvent) {
    const bar = event.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    seek(audioSeekForPointer(event.clientX, rect.left, rect.width, duration));
  }
</script>

<figure class="m-0 flex max-w-[24rem] flex-col gap-1">
  <figcaption class="text-transcript-meta text-muted-foreground">{label}</figcaption>
  {#if media.hasFailed || playbackFailed}
    <p role="status" class="m-0 text-transcript-meta text-muted-foreground">This file is no longer available.</p>
  {:else if media.url}
    <div class="flex h-9 items-center gap-2 rounded-lg bg-muted pr-3 pl-1" role="group" aria-label={label}>
      <audio
        bind:this={player}
        preload="metadata"
        src={media.url}
        onerror={recover}
        onloadedmetadata={readTimes}
        ondurationchange={readTimes}
        ontimeupdate={() => {
          if (!isSeeking) readTimes();
        }}
        onplay={() => (isPlaying = true)}
        onpause={() => (isPlaying = false)}
        onended={() => (isPlaying = false)}
      ></audio>
      <Button variant="ghost" size="icon-sm" aria-label={isPlaying ? "Pause" : "Play"} class="shrink-0 text-foreground pointer-coarse:tap-area" onclick={toggle}>
        {#if isPlaying}<Pause size={16} class="fill-current" />{:else}<Play size={16} class="fill-current" />{/if}
      </Button>
      <span class="shrink-0 font-mono text-transcript-meta text-muted-foreground tabular-nums">{formatAudioTime(current)}</span>
      <div
        role="slider"
        tabindex="0"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        aria-valuetext="{formatAudioTime(current)} of {formatAudioTime(duration)}"
        class="flex h-6 min-w-0 flex-1 cursor-pointer touch-none items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11"
        onkeydown={seekKey}
        onpointerdown={(event) => {
          isSeeking = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekPointer(event);
        }}
        onpointermove={(event) => {
          if (isSeeking) seekPointer(event);
        }}
        onpointerup={() => (isSeeking = false)}
        onpointercancel={() => (isSeeking = false)}
      >
        <span class="relative h-1 w-full overflow-hidden rounded-full bg-foreground/15">
          <span class="absolute inset-0 origin-left rounded-full bg-foreground/80" style:transform={`scaleX(${fraction})`}></span>
        </span>
      </div>
      <span class="shrink-0 font-mono text-transcript-meta text-muted-foreground tabular-nums">{formatAudioTime(duration)}</span>
    </div>
  {:else}
    <p role="status" class="m-0 text-transcript-meta text-muted-foreground">Loading audio…</p>
  {/if}
</figure>
