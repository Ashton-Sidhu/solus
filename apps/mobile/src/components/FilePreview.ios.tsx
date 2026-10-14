// Adapted from T3 Code apps/mobile/src/components/FilePreview.ios.tsx (MIT, see UPSTREAM.md).
// iOS: Quick Look shows an image, a gallery, or a document with its own share control.
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";
import { Alert } from "react-native";

import { nativeViewerErrorMessage } from "../lib/attachmentDownload";
import type { ResolvedFilePreviewSource } from "./FilePreview.types";

export type { ResolvedFilePreviewSource } from "./FilePreview.types";

const FilePreviewModule = requireNativeModule<{
  presentFiles(
    uris: readonly string[],
    names: readonly string[],
    selectedIndex: number,
    identifier: string,
  ): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
}>("SolusFilePreview");

/** One resolved image, gallery, or document. */
export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { uri, name, gallery } = props.source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((message: string) => {
    Alert.alert("Could not open preview", message);
  });

  useEffect(() => {
    let canceled = false;
    const items = gallery && gallery.length > 1 ? gallery : [{ uri, name }];
    void FilePreviewModule.presentFiles(
      items.map((item) => item.uri),
      items.map((item) => item.name ?? "Preview"),
      Math.max(
        0,
        items.findIndex((item) => item.uri === uri),
      ),
      identifier,
    )
      .catch((error: unknown) => {
        if (!canceled) onOpenError(nativeViewerErrorMessage(error));
      })
      .finally(() => {
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      void FilePreviewModule.dismissFile(identifier).catch(() => undefined);
    };
  }, [uri, name, identifier, gallery]);

  return null;
}
