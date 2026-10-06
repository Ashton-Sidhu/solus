// Adapted from T3 Code apps/mobile/src/native/SelectableMarkdownText.tsx (MIT, see UPSTREAM.md).
// The types TypeScript reads; Metro bundles the `.ios` and `.android` files.
import type { SelectableMarkdownTextProps } from "@t3tools/mobile-markdown-text/renderer";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode">;

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

export function SelectableMarkdownText(_props: MobileSelectableMarkdownTextProps) {
  return null;
}
