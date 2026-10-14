// Adapted from T3 Code apps/mobile/src/components/FilePreviewModal.tsx (MIT, see UPSTREAM.md).
// Each item gives its own URL (a host signs a new one), so the group resolves
// with one `Promise.all` instead of a resolver component for each asset.
import { useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Alert, Keyboard } from "react-native";

import { filePreviewGallery, filePreviewName } from "../lib/filePreviewGallery";
import { FilePreview } from "./FilePreview";
import { FilePreviewGallery } from "./FilePreviewGallery";
import type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewItem,
  ResolvedFilePreviewSource,
} from "./FilePreview.types";

function resolvedItem(item: FilePreviewItem, uri: string): ResolvedFilePreviewItem {
  return {
    kind: item.kind,
    uri,
    name: filePreviewName(item),
    mimeType: item.mimeType,
    actionsSource: item.actionsSource,
  };
}

function ResolvedFilePreview(props: {
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
}) {
  const [resolved, setResolved] = useState<ResolvedFilePreviewSource | null>(null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  // Freeze the group at opening; streaming messages and URL renewals must not reopen the viewer.
  const [source] = useState(props.source);
  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    let cancelled = false;
    const items = filePreviewGallery(source, []);
    const selectedIndex = Math.max(
      0,
      items.findIndex((item) => item.key === source.key),
    );
    // One image that cannot load leaves the gallery; the tapped one must load.
    void Promise.all(items.map((item) => item.resolveUri().catch(() => null)))
      .then((uris) => {
        if (cancelled) return;
        const selectedUri = uris[selectedIndex];
        if (!selectedUri) throw new Error("The file could not be loaded.");
        const gallery = items.flatMap((item, index) => {
          const uri = uris[index];
          return uri ? [resolvedItem(item, uri)] : [];
        });
        setResolved({ ...resolvedItem(items[selectedIndex]!, selectedUri), gallery });
      })
      .catch(() => {
        if (cancelled) return;
        Alert.alert(
          "Could not open preview",
          "Reconnect to the host and try again. The file may have been moved or deleted.",
        );
        onRequestClose();
      });
    return () => {
      cancelled = true;
    };
  }, [source]);
  return resolved ? <FilePreview source={resolved} onRequestClose={props.onRequestClose} /> : null;
}

/**
 * Opens an image, a gallery of images, or a document in the platform viewer
 * while `source` is set. The viewer closes when this screen loses focus.
 */
export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly onRequestClose: () => void;
}) {
  const group = useContext(FilePreviewGallery);
  const source = useMemo(
    () =>
      props.source === null
        ? null
        : { ...props.source, gallery: filePreviewGallery(props.source, group) },
    [props.source, group],
  );
  const navigation = useNavigation();
  const subscribeToFocus = useCallback(
    (listener: () => void) => {
      const offFocus = navigation.addListener("focus", listener);
      const offBlur = navigation.addListener("blur", listener);
      return () => {
        offFocus();
        offBlur();
      };
    },
    [navigation],
  );
  const isFocused = useSyncExternalStore(
    subscribeToFocus,
    navigation.isFocused,
    navigation.isFocused,
  );
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (!source || !isFocused) return null;
  return (
    <ResolvedFilePreview key={source.key} source={source} onRequestClose={props.onRequestClose} />
  );
}
