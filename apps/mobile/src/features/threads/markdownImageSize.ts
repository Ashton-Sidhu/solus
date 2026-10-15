// Adapted from T3 Code apps/mobile/src/features/threads/markdownImageSize.ts (MIT, see UPSTREAM.md).
export const MARKDOWN_IMAGE_MAX_WIDTH = 480;
export const MARKDOWN_IMAGE_MAX_HEIGHT = 480;

export interface MarkdownImageDisplaySize {
  readonly width: number;
  readonly height: number;
}

/** The size attributes of an SVG root element. */
export interface SvgSizeAttributes {
  readonly width?: unknown;
  readonly height?: unknown;
  readonly viewBox?: unknown;
}

/** An SVG's drawn size: pixel `width` and `height`, else its `viewBox`; null when it has neither. */
export function resolveSvgImageSize(props: SvgSizeAttributes) {
  const dimension = (value: unknown) => {
    if (typeof value === "number") return value;
    if (typeof value !== "string" || !/^\s*\d+(?:\.\d+)?(?:px)?\s*$/.test(value)) return NaN;
    return Number.parseFloat(value);
  };
  const width = dimension(props.width);
  const height = dimension(props.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    return { width, height };
  const viewBox =
    typeof props.viewBox === "string"
      ? props.viewBox
          .trim()
          .split(/[\s,]+/)
          .map(Number)
      : [];
  if (
    viewBox.length !== 4 ||
    !viewBox.every(Number.isFinite) ||
    viewBox[2]! <= 0 ||
    viewBox[3]! <= 0
  )
    return null;
  return { width: viewBox[2]!, height: viewBox[3]! };
}

/** Keeps small images intrinsic while fitting larger images inside the chat viewport. */
export function resolveMarkdownImageDisplaySize(input: {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly availableWidth: number;
}): MarkdownImageDisplaySize | null {
  if (
    !Number.isFinite(input.sourceWidth) ||
    !Number.isFinite(input.sourceHeight) ||
    !Number.isFinite(input.availableWidth) ||
    input.sourceWidth <= 0 ||
    input.sourceHeight <= 0 ||
    input.availableWidth <= 0
  ) {
    return null;
  }

  const scale = Math.min(
    1,
    input.availableWidth / input.sourceWidth,
    MARKDOWN_IMAGE_MAX_WIDTH / input.sourceWidth,
    MARKDOWN_IMAGE_MAX_HEIGHT / input.sourceHeight,
  );

  return {
    width: input.sourceWidth * scale,
    height: input.sourceHeight * scale,
  };
}

/** Thumbnail cards hold a fixed frame and name the image below the card. */
export function resolveMarkdownImageFrame(input: {
  thumbnail?: boolean;
  displaySize: MarkdownImageDisplaySize | null;
  placeholderWidth: number | "100%";
  alt: string | null;
}) {
  if (input.thumbnail) return { style: { width: 110, height: 56 }, caption: null };
  return { style: input.displaySize ?? { width: input.placeholderWidth, aspectRatio: 16 / 9 }, caption: input.alt };
}
