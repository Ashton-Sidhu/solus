// Adapted from T3 Code apps/mobile/src/native/SelectableMarkdownText.types.ts (MIT, see UPSTREAM.md).
// No skills, context clipboard, file chip menu, or link customization: Solus has none on the phone.
import type { ReactNode } from "react";

export interface NativeMarkdownTextStyle {
  readonly selectionColor?: string;
  readonly selectionHandleColor?: string;
  readonly color: string;
  readonly strongColor: string;
  readonly mutedColor: string;
  readonly linkColor: string;
  readonly inlineCodeColor: string;
  readonly codeColor: string;
  readonly codeBackgroundColor: string;
  readonly codeBlockBackgroundColor: string;
  readonly fileTextColor: string;
  readonly quoteMarkerColor: string;
  readonly dividerColor: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontFamily: string;
  readonly headingFontFamily: string;
  readonly boldFontFamily: string;
  readonly headingFontSizes?: ReadonlyArray<number>;
}

export interface MarkdownImageRequest {
  readonly href: string;
  readonly alt: string | null;
  readonly title: string | null;
}

/**
 * App-supplied renderer for markdown images. The renderer cannot load host
 * paths itself — the app resolves them (through a URL the host signs) and
 * returns the element to show. Returning null keeps Enriched's native media
 * rendering.
 */
export type MarkdownImageRenderer = (image: MarkdownImageRequest) => ReactNode;

/** The address Enriched loads an image from where it draws the image itself (in a table or quote). */
export type MarkdownImageSourceResolver = (
  image: MarkdownImageRequest,
) => { uri: string } | null | Promise<{ uri: string } | null>;

export interface SelectableMarkdownTextProps {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly preserveSoftBreaks?: boolean;
  readonly onLinkPress?: (href: string) => void;
  readonly renderImage?: MarkdownImageRenderer;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly onImagePress?: (href: string) => void;
}
