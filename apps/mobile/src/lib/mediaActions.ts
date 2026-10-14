// Adapted from T3 Code apps/mobile/src/state/mediaActions.ts (MIT, see UPSTREAM.md).
// The URL comes from the source's own `resolveUri` (a host signs a new one), not
// from an environment asset; no filesystem grant check, because a host that
// refuses to sign a file makes the action fail with its own message.
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

import type { MediaActionsSource } from "../components/FilePreview.types";
import type { RootStackParamList } from "../navigation/routes";
import { downloadAndShareAttachment } from "./attachmentDownload";
import { copyTextWithHaptic } from "./copyTextWithHaptic";

export type MediaActionId = "copy-full-path" | "copy-relative-path" | "copy-url" | "open-file" | "save";

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
  const [sharing, setSharing] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);

  const share = () => {
    if (!source || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setSharing(true);
    void (async () => {
      const uri = await source.resolveUri();
      if (request.signal.aborted) return;
      if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      await downloadAndShareAttachment({
        url: uri,
        attachment: { name: source.name, mimeType: source.mimeType },
        signal: request.signal,
      });
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Alert.alert(
            "Could not share file",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (controller.current === request) {
          controller.current = null;
          if (!request.signal.aborted) setSharing(false);
        }
      });
  };

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
        {
          id: "save" as const,
          title: sharing ? "Opening share sheet…" : "Save or share",
          run: share,
          disabled: sharing,
        },
      ]
    : [];
  return {
    title: reference?.kind === "file" ? reference.path : reference?.url,
    actions,
    sharing,
    share,
  };
}
