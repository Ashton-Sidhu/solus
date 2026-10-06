// Adapted from T3 Code apps/mobile/src/components/PierreEntryIcon.tsx (MIT, see UPSTREAM.md).
// Files only: Solus attachments are never directories.
import { markdownFileIconSource } from "@t3tools/mobile-markdown-text/file-icons";
import { resolveMarkdownFileIcon } from "@t3tools/mobile-markdown-text/links";
import { Image } from "react-native";

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
