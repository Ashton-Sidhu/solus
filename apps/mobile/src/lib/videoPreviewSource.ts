// Adapted from T3 Code apps/mobile/src/lib/videoPreviewSource.ts (MIT, see UPSTREAM.md).
// One source shape: the URL comes from `resolveUri` (a host signs host files),
// not an environment asset; no local draft videos.
import type { MediaActionsSource } from "../components/FilePreview.types";

export interface VideoPreviewSource {
  readonly name: string;
  /** The identity of the video, never a signed URL that changes. */
  readonly key: string;
  /** Mints the URL to play; called again when playback needs a new one. */
  readonly resolveUri: () => Promise<string | null>;
  readonly actionsSource?: MediaActionsSource;
}
