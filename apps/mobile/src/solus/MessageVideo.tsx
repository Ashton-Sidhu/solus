import { useContext, useEffect, useState } from "react";
import { MediaVideoPlayer } from "../components/MediaVideoPlayer";
import { ThreadMediaVisibleContext } from "../features/threads/ThreadMarkdownVideo";
import type { UploadVideo } from "./upload-images";

/** Solus signs a host path on demand. The T3 player owns the poster and playback. */
export function MessageVideo({ attachment, thumbnailKey, onPlaybackStart }: {
  attachment: UploadVideo;
  thumbnailKey: string;
  onPlaybackStart: () => void;
}) {
  const visible = useContext(ThreadMediaVisibleContext);
  const preview = attachment.videoPreview;
  const [resolved, setResolved] = useState<{ preview: typeof preview; uri: string | null } | null>(null);
  useEffect(() => {
    if (!visible || "uri" in preview) return;
    let active = true;
    void preview.resolveUrl().then(
      uri => { if (active) setResolved({ preview, uri }); },
      () => { if (active) setResolved({ preview, uri: null }); },
    );
    return () => { active = false; };
  }, [visible, preview]);

  const result = resolved?.preview === preview ? resolved : null;
  return <MediaVideoPlayer
    name={attachment.name}
    uri={"uri" in preview ? preview.uri : result?.uri ?? null}
    resolvePlaybackUri={"resolveUrl" in preview ? () => preview.resolveUrl(true) : undefined}
    thumbnailKey={thumbnailKey}
    visible={visible}
    thumbnailVisible={visible}
    unavailable={result !== null && !result.uri}
    onPlaybackStart={onPlaybackStart}
    borderRadius={20}
  />;
}
