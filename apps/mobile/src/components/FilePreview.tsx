// Adapted from T3 Code apps/mobile/src/components/FilePreview.tsx and FilePreviewModal.types.ts (MIT, see UPSTREAM.md).
// Images only: T3's document viewer and iOS Quick Look module are not ported.
import ImageViewing from "react-native-image-viewing";

import { MediaImagePreview } from "./MediaImagePreview";

export interface ResolvedFilePreviewSource {
  readonly kind: "image";
  readonly uri: string;
  readonly name?: string;
  /** The authored reference (a host path or URL), shown under the name. */
  readonly caption?: string;
}

export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  if (props.source.caption) return <MediaImagePreview {...props} />;
  return (
    <ImageViewing
      images={[{ uri: props.source.uri }]}
      imageIndex={0}
      visible
      onRequestClose={props.onRequestClose}
      swipeToCloseEnabled
      doubleTapToZoomEnabled
    />
  );
}
