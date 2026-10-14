// Adapted from T3 Code apps/mobile/src/components/FilePreview.tsx (MIT, see UPSTREAM.md).
// Android: images in the in-app viewer, a PDF or other document in another app's viewer.
import { useEffect, useEffectEvent } from "react";
import { Alert, Modal, Pressable, View } from "react-native";

import { nativeViewerErrorMessage, openAttachmentInViewer } from "../lib/attachmentDownload";
import { AppText as Text } from "./AppText";
import type { ResolvedFilePreviewSource } from "./FilePreview.types";
import { MediaImagePreview } from "./MediaImagePreview";

export type { ResolvedFilePreviewSource } from "./FilePreview.types";

function DocumentPreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  const { uri, name } = props.source;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((message: string) => {
    Alert.alert("Could not open document", message);
  });
  useEffect(() => {
    const controller = new AbortController();
    const opened = openAttachmentInViewer({
      uri,
      attachment: {
        name: name ?? "Document",
        mimeType:
          props.source.mimeType ??
          (props.source.kind === "pdf" ? "application/pdf" : "application/octet-stream"),
      },
      signal: controller.signal,
    });
    void opened
      .catch((error: unknown) => {
        if (!controller.signal.aborted) onOpenError(nativeViewerErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) onRequestClose();
      });
    return () => controller.abort();
  }, [uri, name, props.source.mimeType, props.source.kind]);
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onRequestClose}>
      <View className="flex-1 items-center justify-center bg-backdrop p-6">
        <View className="w-full max-w-sm gap-4 rounded-2xl bg-sheet-solid p-6">
          <Text className="font-t3-semibold text-foreground">Opening document…</Text>
          <Text className="text-foreground-muted" numberOfLines={2}>
            {name ?? "Document"}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={props.onRequestClose}
            className="self-end p-3"
          >
            <Text className="text-foreground">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** One resolved image, gallery, or document. */
export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  if (props.source.kind !== "image") return <DocumentPreview {...props} />;
  return <MediaImagePreview {...props} />;
}
