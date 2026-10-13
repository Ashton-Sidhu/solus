// Adapted from T3 Code apps/mobile/src/components/PierreEntryIcon.tsx (MIT, see UPSTREAM.md).
// Files only: Solus attachments are never directories.
import { Image } from "react-native";

import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { resolveMarkdownFileIcon } from "../lib/markdownLinks";

/** A file's type icon by its name, from the Pierre set T3 bundles (no native rebuild). */
export function PierreEntryIcon(props: { readonly path: string; readonly size?: number }) {
  const size = props.size ?? 16;
  return (
    <Image
      source={markdownFileIconSource(resolveMarkdownFileIcon(props.path))}
      resizeMode="contain"
      accessible={false}
      style={{ width: size, height: size }}
    />
  );
}
