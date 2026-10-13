// Adapted from T3 Code apps/mobile/src/native/EnrichedMarkdownText.tsx (MIT, see UPSTREAM.md).
// No context chips, context clipboard, skills, or file chip menu: Solus has none on the
// phone, so a link's long press shows the iOS link menu (Open, Copy, Share). The text is
// the system font, so bold text and headings ask for a bold weight.
import { useCallback, useMemo, useState } from "react";
import { Platform, Share, StyleSheet, View } from "react-native";
import {
  EnrichedMarkdownText,
  type DocumentAssetsEvent,
  type MarkdownMediaAsset,
  type MarkdownStyle,
} from "react-native-enriched-markdown";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedLinkVariantPattern,
} from "../lib/enrichedLinkPresentation";
import { markdownWithHtml } from "../lib/markdownDocument";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";

const LINK_RECOGNITION = { inlineCode: ENRICHED_INLINE_FILE_LINK_REGEX };

function enrichedStyle(
  style: SelectableMarkdownTextProps["textStyle"],
  dark: boolean,
): MarkdownStyle {
  const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
  // Keep the radius modest: iOS clips square table-cell borders without stroking the corner arcs.
  const block = {
    marginTop: 4,
    marginBottom: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: style.dividerColor,
  };
  const body = {
    color: style.color,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    marginTop: 0,
    marginBottom: 8,
  };
  const heading = (level: number) => {
    const fontSize = style.headingFontSizes?.[level - 1] ?? style.fontSize * (1.6 - level * 0.1);
    return {
      ...body,
      color: style.strongColor,
      fontFamily: style.headingFontFamily,
      fontWeight: "700",
      fontSize,
      lineHeight: fontSize * 1.35,
      marginTop: 8,
    };
  };
  return {
    paragraph: body,
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "bold" },
    link: { color: style.linkColor, underline: false },
    code: {
      fontFamily: monospace,
      color: style.inlineCodeColor,
      backgroundColor: "transparent",
      borderColor: "transparent",
      fontSize: style.fontSize * 0.9,
    },
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: style.fontSize * 0.9,
      ...block,
      padding: 12,
      syntaxColors: dark
        ? {
            keyword: "#ff7b72",
            string: "#a5d6ff",
            number: "#79c0ff",
            constant: "#79c0ff",
            comment: "#8b949e",
            function: "#d2a8ff",
            type: "#ffa657",
            property: "#79c0ff",
            tag: "#7ee787",
            attribute: "#79c0ff",
          }
        : {
            keyword: "#cf222e",
            string: "#0a3069",
            number: "#0550ae",
            constant: "#0550ae",
            comment: "#6e7781",
            function: "#8250df",
            type: "#953800",
            property: "#0550ae",
            tag: "#116329",
            attribute: "#0550ae",
          },
    },
    blockquote: {
      ...body,
      color: style.mutedColor,
      backgroundColor: "transparent",
      borderColor: style.quoteMarkerColor,
      borderWidth: 2,
      gapWidth: 12,
    },
    list: { ...body, bulletColor: style.mutedColor, markerColor: style.mutedColor, gapWidth: 6 },
    thematicBreak: { color: style.dividerColor, height: 1, marginTop: 8, marginBottom: 8 },
    table: {
      ...body,
      ...block,
      headerFontFamily: style.boldFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.codeBlockBackgroundColor,
      rowEvenBackgroundColor: "transparent",
      rowOddBackgroundColor: "transparent",
      cellPaddingHorizontal: 10,
      cellPaddingVertical: 7,
    },
    taskList: {
      checkedColor: style.linkColor,
      checkedTextColor: style.color,
      borderColor: style.mutedColor,
      checkedStrikethrough: false,
    },
  };
}

export function MobileEnrichedMarkdownText(props: SelectableMarkdownTextProps) {
  const { onLinkPress, onImagePress, renderImage, resolveImageSource } = props;
  const markdown = useMemo(() => markdownWithHtml(props.markdown), [props.markdown]);
  const { themeAppearance } = useAppearancePreferences();
  const [documentAssets, setDocumentAssets] = useState<DocumentAssetsEvent["assets"]>([]);
  const onDocumentAssets = useCallback(({ assets }: DocumentAssetsEvent) => {
    setDocumentAssets((previous) =>
      previous.length === assets.length &&
      previous.every((asset, index) => {
        const next = assets[index]!;
        return (
          asset.id === next.id &&
          asset.kind === next.kind &&
          asset.url === next.url &&
          asset.altText === next.altText &&
          asset.title === next.title &&
          asset.placement === next.placement &&
          asset.eligible === next.eligible
        );
      })
        ? previous
        : assets,
    );
  }, []);
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(
    documentAssets,
    props.textStyle,
  );
  const linkContextMenuItems = useMemo(
    () =>
      Platform.OS === "ios" && onLinkPress
        ? Object.fromEntries(
            [
              ...new Set(
                documentAssets.filter((asset) => asset.kind === "link").map((asset) => asset.url),
              ),
            ].map((url) => [
              enrichedLinkVariantPattern(url),
              [
                { text: "Open link", onPress: () => onLinkPress(url) },
                { text: "Copy link", onPress: () => copyTextWithHaptic(url) },
                { text: "Share link", onPress: () => void Share.share({ message: url }) },
              ],
            ]),
          )
        : undefined,
    [documentAssets, onLinkPress],
  );
  const markdownStyle = useMemo(
    () => ({ ...enrichedStyle(props.textStyle, themeAppearance === "dark"), linkVariants }),
    [props.textStyle, themeAppearance, linkVariants],
  );
  const renderMedia = useCallback(
    (asset: MarkdownMediaAsset) =>
      renderImage?.({
        href: asset.url,
        alt: asset.altText || null,
        title: asset.title || null,
      }) ?? null,
    [renderImage],
  );
  const resolveNativeImageSource = useCallback(
    (asset: MarkdownMediaAsset) =>
      resolveImageSource?.({
        href: asset.url,
        alt: asset.altText || null,
        title: asset.title || null,
      }) ?? null,
    [resolveImageSource],
  );
  const pressImage = onImagePress ?? onLinkPress;

  return (
    <View style={{ flexShrink: 1, minWidth: 0 }}>
      <EnrichedMarkdownText
        markdown={markdown}
        markdownStyle={markdownStyle}
        onDocumentAssets={onDocumentAssets}
        renderMedia={renderImage ? renderMedia : undefined}
        resolveImageSource={resolveImageSource ? resolveNativeImageSource : undefined}
        onImagePress={pressImage ? ({ url }) => pressImage(url) : undefined}
        linkRecognition={LINK_RECOGNITION}
        containerStyle={{ flexShrink: 1, minWidth: 0 }}
        flavor="github"
        selectable
        selectionColor={props.textStyle.selectionColor}
        selectionHandleColor={props.textStyle.selectionHandleColor}
        md4cFlags={{
          latexMath: false,
          hardSoftBreaks: props.preserveSoftBreaks ?? false,
          admonitions: true,
        }}
        enableTaskListItemToggle={false}
        spoilerOverlay="solid"
        onLinkPress={onLinkPress ? ({ url }) => onLinkPress(url) : undefined}
        linkContextMenuItems={linkContextMenuItems}
        linkPillContent={linkPillContent}
      />
    </View>
  );
}
