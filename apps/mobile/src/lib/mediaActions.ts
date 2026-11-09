// Adapted from T3 Code apps/mobile/src/state/mediaActions.ts (MIT, see UPSTREAM.md).
// The URL comes from the source's own `resolveUri` (a host signs a new one), not
// from an environment asset; no filesystem grant check, because a host that
// refuses to sign a file makes the action fail with its own message.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";

import type { MediaActionsSource } from "../components/FilePreview.types";
import type { RootStackParamList } from "../navigation/routes";
import { downloadAndSaveImage, downloadAndShareAttachment } from "./attachmentDownload";
import { copyTextWithHaptic } from "./copyTextWithHaptic";
import { canSaveImageToLibrary } from "./saveImageToLibrary";

export type MediaActionId =
  | "copy-full-path"
  | "copy-relative-path"
  | "copy-url"
  | "open-file"
  | "save"
  | "save-image";

export interface MediaAction {
  readonly id: MediaActionId;
  readonly title: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

export interface MediaActions {
  /** The authored reference, shown as the menu title and under a viewer's name. */
  readonly title: string | undefined;
  readonly actions: readonly MediaAction[];
  readonly sharing: boolean;
  readonly share: () => void;
}

export function useMediaActions(
  source: MediaActionsSource | undefined,
  onOpenFile?: () => void,
): MediaActions {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState<"share" | "save-image" | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  /** Downloads the original bytes and hands them to the share sheet or to Photos. */
  const run = (kind: "share" | "save-image") => {
    if (!source || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(kind);
    void (async () => {
      const uri = await source.resolveUri();
      if (request.signal.aborted) return;
      if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      const input = {
        url: uri,
        attachment: { name: source.name, mimeType: source.mimeType },
        signal: request.signal,
      };
      if (kind === "share") await downloadAndShareAttachment(input);
      else await downloadAndSaveImage(input);
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Alert.alert(
            kind === "share" ? "Could not share file" : "Could not save image",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (controller.current === request) {
          controller.current = null;
          if (!request.signal.aborted) setBusy(null);
        }
      });
  };
  const share = () => run("share");
  const canSaveImage = source !== undefined && canSaveImageToLibrary(source.mimeType, Platform);

  const reference = source?.reference;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const file = source?.file;
  const actions: MediaAction[] = source
    ? [
        ...(reference?.kind === "file"
          ? [
              {
                id: "copy-full-path" as const,
                title: "Copy full path",
                run: () => copyTextWithHaptic(reference.path),
              },
            ]
          : []),
        ...(relativePath
          ? [
              {
                id: "copy-relative-path" as const,
                title: "Copy relative path",
                run: () => copyTextWithHaptic(relativePath),
              },
            ]
          : []),
        ...(reference?.kind === "url"
          ? [
              {
                id: "copy-url" as const,
                title: "Copy URL",
                run: () => copyTextWithHaptic(reference.url),
              },
            ]
          : []),
        ...(file
          ? [
              {
                id: "open-file" as const,
                title: "Open in file viewer",
                run: () => {
                  onOpenFile?.();
                  navigation.navigate("File", file);
                },
              },
            ]
          : []),
        ...(canSaveImage
          ? [
              {
                id: "save-image" as const,
                title: busy === "save-image" ? "Saving image…" : "Save image",
                run: () => run("save-image"),
                disabled: busy !== null,
              },
            ]
          : []),
        {
          id: "save" as const,
          title:
            busy === "share" ? "Opening share sheet…" : canSaveImage ? "Share" : "Save or share",
          run: share,
          disabled: busy !== null,
        },
      ]
    : [];
  return {
    title: reference?.kind === "file" ? reference.path : reference?.url,
    actions,
    sharing: busy === "share",
    share,
  };
}
