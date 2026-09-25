<script lang="ts">
  import type { BrowserRecordingRef } from "@solus/contracts/browser-types";
  import { Video as VideoIcon } from "@lucide/svelte";
  import type { HostMediaRequest } from "../../lib/host-media-url.svelte";
  import { relativeTime } from "../../lib/relative-time";
  import TranscriptCard from "../conversation/TranscriptCard.svelte";
  import { HostVideoPlayer } from "../ui/video-player";
  import {
    recordingCaption,
    recordingStopNote,
    recordingTitle,
  } from "./lib/recording";

  /**
   * A recording an agent made of a browser page, as a player.
   *
   * Like a snapshot, the card is what the user sees whatever the agent writes
   * after it. The wire carries an asset id; the host signs a URL for the video
   * when the player needs it.
   */
  interface Props {
    recording: BrowserRecordingRef;
    /** The host that stored the recording. */
    serverId: string | undefined;
    skipMotion?: boolean;
  }

  let { recording, serverId, skipMotion = false }: Props = $props();

  const title = $derived(recordingTitle(recording));
  const caption = $derived(recordingCaption(recording));
  const stopNote = $derived(recordingStopNote(recording));
  const request = $derived<HostMediaRequest | null>(
    serverId
      ? {
          serverId,
          assetId: recording.assetId,
          // An asset id always resolves through a signed URL, so this client
          // never reads the host's disk for it.
          canReadLocalFiles: false,
        }
      : null,
  );
</script>

<TranscriptCard
  title="Recording"
  target={caption}
  ariaLabel={`Recording of ${title}`}
  bodyLayout="media"
  data-testid="browser-recording-card"
  {skipMotion}
>
  {#snippet glyph()}<VideoIcon />{/snippet}
  {#snippet rail()}
    <span>{relativeTime(recording.capturedAt)}</span>
  {/snippet}
  {#snippet body()}
    <HostVideoPlayer {request} label={title} class="max-h-[20rem] w-full" />
    <!-- A limit or a closed page ended it early: the video is shorter than
         the flow may have been, and the reader has to know why. -->
    {#if stopNote}
      <p class="px-3 py-1.5 text-review-meta text-(--muted-foreground)">
        {stopNote}
      </p>
    {/if}
  {/snippet}
</TranscriptCard>
