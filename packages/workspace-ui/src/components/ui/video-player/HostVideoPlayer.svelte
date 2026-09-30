<script lang="ts">
  import VideoPlayer from "./VideoPlayer.svelte";
  import { HostMediaUrl, type HostMediaRequest } from "../../../lib/host-media-url.svelte";

  interface Props {
    /** The host file or asset to play. Null shows the loading slot. */
    request: HostMediaRequest | null;
    label: string;
    poster?: string;
    class?: string;
  }

  let { request, label, poster, class: className }: Props = $props();
  const media = new HostMediaUrl(() => request);
</script>

<VideoPlayer
  src={media.url}
  {label}
  {poster}
  sourceFailed={media.hasFailed}
  onRetry={() => media.retry()}
  class={className}
/>
