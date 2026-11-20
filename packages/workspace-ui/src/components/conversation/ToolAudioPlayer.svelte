<script lang="ts">
  import type { ToolResultAudio } from "@solus/contracts/types";
  import { HostMediaUrl } from "../../lib/host-media-url.svelte";
  import { getMarkdownImageContext } from "./lib/markdown-image";

  let { audio, label }: { audio: ToolResultAudio; label: string } = $props();
  const context = getMarkdownImageContext();
  const media = new HostMediaUrl(() => {
    const serverId = context?.serverId();
    return serverId ? { serverId, assetId: audio.assetId, ctx: context?.ctx() } : null;
  });
  let playbackFailed = $state(false);
  let hasRetried = false;

  /** A signed URL can expire while the row is open: mint one new URL, then give up. */
  async function recover() {
    if (hasRetried) {
      playbackFailed = true;
      return;
    }
    hasRetried = true;
    await media.retry().catch(() => (playbackFailed = true));
  }
</script>

<figure class="m-0 flex max-w-[24rem] flex-col gap-1">
  <figcaption class="text-chrome-dense text-muted-foreground">{label}</figcaption>
  {#if media.hasFailed || playbackFailed}
    <p role="status" class="m-0 text-chrome-dense text-muted-foreground">This file is no longer available.</p>
  {:else if media.url}
    <audio controls preload="metadata" src={media.url} aria-label={label} onerror={recover} class="h-9 w-full"></audio>
  {:else}
    <p role="status" class="m-0 text-chrome-dense text-muted-foreground">Loading audio…</p>
  {/if}
</figure>
