// Adapted from T3 Code apps/mobile/src/native/EnrichedMarkdownText.tsx (MIT, see UPSTREAM.md).
// No context chips, context clipboard, skills, or file chip menu: Solus has none on the
// phone, so a link's long press shows the iOS link menu (Open, Copy, Share). The text
// recognition slot T3 uses for skills finds `@path` mentions.
import { isValidElement, useCallback, useMemo, useState } from "react";
import { Platform, Share, View } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownImageBlock,
  type MarkdownLinkOccurrence,
  type MarkdownStyle,
} from "react-native-enriched-markdown";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedLinkVariantPattern,
  recognizedLinkUrls,
} from "../lib/enrichedLinkPresentation";
import { FILE_MENTION_REGEX } from "../lib/fileMentions";
import { markdownWithBlockImages, markdownWithHtml } from "../lib/markdownDocument";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";
import { useRetryingImageSource } from "./useRetryingImageSource";

const LINK_RECOGNITION = { inlineCode: ENRICHED_INLINE_FILE_LINK_REGEX };
const LINK_AND_MENTION_RECOGNITION = { ...LINK_RECOGNITION, text: FILE_MENTION_REGEX };

function enrichedStyle(
  style: SelectableMarkdownTextProps["textStyle"],
  dark: boolean,
): MarkdownStyle {
  const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";
  const block = { marginTop: 4, marginBottom: 12 };
  // Desktop's `.prose-cloud pre` is 0.75rem against a 0.875rem body, at 1.55 leading.
  const codeBlockFontSize = style.fontSize * (0.75 / 0.875);
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
    strong: { color: style.strongColor, fontFamily: style.boldFontFamily, fontWeight: "normal" },
    link: { color: style.linkColor, underline: false },
    code: {
      fontFamily: monospace,
      color: style.inlineCodeColor,
      backgroundColor: "transparent",
      borderColor: "transparent",
      fontSize: style.fontSize * 0.9,
    },
    // Desktop's chat code block (`.solus-code-block`): the code tint panel, a soft
    // border, and a 10px radius.
    codeBlock: {
      ...body,
      color: style.codeColor,
      backgroundColor: style.codeBlockBackgroundColor,
      fontFamily: monospace,
      fontSize: codeBlockFontSize,
      lineHeight: codeBlockFontSize * 1.55,
      ...block,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: style.blockBorderColor,
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
    // Desktop's `.prose-cloud table`: square, soft 1px rules, and a plain header fill.
    // Enriched draws a full grid (it has no style for row rules only), so the
    // column lines take the same soft color as the rows.
    table: {
      ...body,
      ...block,
      borderRadius: 0,
      borderWidth: 1,
      borderColor: style.blockBorderColor,
      headerFontFamily: style.tableHeaderFontFamily,
      headerTextColor: style.strongColor,
      headerBackgroundColor: style.tableHeaderBackgroundColor,
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
  const { onLinkPress, onImagePress, onQuote, renderImage, resolveImageSource } = props;
  const markdown = useMemo(
    () => markdownWithBlockImages(markdownWithHtml(props.markdown)),
    [props.markdown],
  );
  const { themeAppearance } = useAppearancePreferences();
  const [parsedLinkUrls, setParsedLinkUrls] = useState<ReadonlyArray<string>>([]);
  const onLinksChange = useCallback((links: MarkdownLinkOccurrence[]) => {
    const urls = [...new Set(links.map((link) => link.url))];
    setParsedLinkUrls((previous) =>
      previous.length === urls.length && previous.every((url, index) => url === urls[index])
        ? previous
        : urls,
    );
  }, []);
  // linkRecognition adds file links and mentions as the text is drawn, so
  // onLinksChange never reports them. Joined so a streaming tick keeps the value.
  const recognizedLinkKey = useMemo(
    () => recognizedLinkUrls(markdown, props.recognizeFileMentions ? FILE_MENTION_REGEX : undefined).join("\n"),
    [markdown, props.recognizeFileMentions],
  );
  const linkUrls = useMemo(
    () =>
      recognizedLinkKey
        ? [...new Set([...parsedLinkUrls, ...recognizedLinkKey.split("\n")])]
        : parsedLinkUrls,
    [parsedLinkUrls, recognizedLinkKey],
  );
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(
    linkUrls,
    props.textStyle,
    props.fileChipHrefs,
  );
  const linkContextMenuItems = useMemo(
    () =>
      Platform.OS === "ios" && onLinkPress
        ? Object.fromEntries(
            linkUrls.map((url) => [
              enrichedLinkVariantPattern(url),
              [
                { text: "Open link", onPress: () => onLinkPress(url) },
                { text: "Copy link", onPress: () => copyTextWithHaptic(url) },
                { text: "Share link", onPress: () => void Share.share({ message: url }) },
              ],
            ]),
          )
        : undefined,
    [linkUrls, onLinkPress],
  );
  const contextMenuItems = useMemo(
    () =>
      onQuote
        ? [{ text: "Quote in reply", icon: "text.quote", onPress: ({ text }: { text: string }) => onQuote(text) }]
        : undefined,
    [onQuote],
  );
  const markdownStyle = useMemo(
    () => ({ ...enrichedStyle(props.textStyle, themeAppearance === "dark"), linkVariants }),
    [props.textStyle, themeAppearance, linkVariants],
  );
  const renderers = useMemo(
    () =>
      renderImage
        ? {
            image: (block: MarkdownImageBlock) => {
              const element = renderImage({
                href: block.url,
                alt: block.altText || null,
                title: block.title || null,
              });
              return isValidElement(element) ? element : undefined;
            },
          }
        : undefined,
    [renderImage],
  );
  const resolveNativeImageSource = useRetryingImageSource(resolveImageSource);
  const pressImage = onImagePress ?? onLinkPress;

  return (
    <View style={{ flexShrink: 1, minWidth: 0 }}>
      <EnrichedMarkdownText
        markdown={markdown}
        markdownStyle={markdownStyle}
        onLinksChange={onLinksChange}
        renderers={renderers}
        resolveImageSource={resolveNativeImageSource}
        onImagePress={pressImage ? ({ url }) => pressImage(url) : undefined}
        linkRecognition={props.recognizeFileMentions ? LINK_AND_MENTION_RECOGNITION : LINK_RECOGNITION}
        containerStyle={{ flexShrink: 1, minWidth: 0 }}
        flavor="github"
        selectable
        md4cFlags={{
          latexMath: false,
          hardSoftBreaks: props.preserveSoftBreaks ?? false,
          admonitions: true,
        }}
        enableTaskListItemToggle={false}
        enableCodeBlockWrapToggle={false}
        spoilerOverlay="solid"
        onLinkPress={onLinkPress ? ({ url }) => onLinkPress(url) : undefined}
        contextMenuItems={contextMenuItems}
        linkContextMenuItems={linkContextMenuItems}
        linkPillContent={linkPillContent}
      />
    </View>
  );
}
