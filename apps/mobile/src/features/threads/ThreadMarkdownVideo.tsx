// Adapted from T3 Code apps/mobile/src/features/threads/ThreadMarkdownVideo.tsx (MIT, see UPSTREAM.md).
// The URL comes from the source's own `resolveUri` (a host signs host files), not an asset atom.
import { useEffect, useEffectEvent, useState } from "react";

import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import type { VideoPreviewSource } from "../../components/VideoPreviewModal";

/** A video a Markdown image names, played inline. */
export function ThreadMarkdownVideo(props: { readonly source: VideoPreviewSource }) {
  const { source } = props;
  const [state, setState] = useState<{ uri: string | null; unavailable: boolean }>({
    uri: null,
    unavailable: false,
  });
  const resolveUri = useEffectEvent(source.resolveUri);
  // The key is the video's identity; a new source object for the same video keeps its URL.
  useEffect(() => {
    let active = true;
    void resolveUri().then(
      (uri) => {
        if (active) setState({ uri, unavailable: uri === null });
      },
      () => {
        if (active) setState({ uri: null, unavailable: true });
      },
    );
    return () => {
      active = false;
    };
  }, [source.key]);
  return (
    <MediaVideoPlayer
      uri={state.uri}
      resolvePlaybackUri={source.resolveUri}
      name={source.name}
      thumbnailKey={source.key}
      unavailable={state.unavailable}
      actionsSource={source.actionsSource}
    />
  );
}
