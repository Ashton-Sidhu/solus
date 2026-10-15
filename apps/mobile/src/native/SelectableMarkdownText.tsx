// Adapted from T3 Code apps/mobile/src/native/SelectableMarkdownText.tsx (MIT, see UPSTREAM.md).
// Selection uses the device's own colors, so the markdown view needs no wrapper.
export { MobileEnrichedMarkdownText as SelectableMarkdownText } from "./EnrichedMarkdownText";
export type {
  MarkdownImageRenderer,
  MarkdownImageRequest,
  MarkdownImageSourceResolver,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";
