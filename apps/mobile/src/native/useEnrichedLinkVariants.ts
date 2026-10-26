// Adapted from T3 Code apps/mobile/src/native/useEnrichedLinkVariants.ts (MIT, see UPSTREAM.md).
// File links, `@path` mentions, and GitHub links only: no link customization,
// context chips, or skills. A mention wears T3's mention context chip.
import { replyImage } from "@solus/client-core/reply-images";
import { useMemo } from "react";
import { Image, type ImageSourcePropType } from "react-native";
import type { LinkPillContent, MarkdownStyle } from "react-native-enriched-markdown";

import { enrichedLinkVariantPattern, mentionChipColor } from "../lib/enrichedLinkPresentation";
import { fileMentionPath } from "../lib/fileMentions";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import { fileBasename } from "../lib/markdownLinkTargets";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

interface EnrichedLinkPresentation {
  readonly color: string;
  readonly label?: string;
  readonly icon: ImageSourcePropType;
  readonly iconTintColor?: string;
}

/**
 * A mention is T3's mention chip: its accent (`mentionChipColor`, readable in
 * the theme), the document icon, and the file name. A file link is a pill with its type icon and file name; a GitHub link
 * gets the GitHub mark.
 */
export function enrichedLinkPresentation(
  url: string,
  textStyle: NativeMarkdownTextStyle,
  mentionColor: string,
  fileChip = false,
): EnrichedLinkPresentation | undefined {
  if (fileChip) return { color: textStyle.fileTextColor, label: replyImage(url).label, icon: markdownFileIconSource("image") };
  const mentionPath = fileMentionPath(url);
  if (mentionPath !== null)
    return {
      color: mentionColor,
      label: fileBasename(mentionPath),
      icon: markdownFileIconSource("default"),
    };
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      color: textStyle.fileTextColor,
      label: link.label,
      icon: markdownFileIconSource(link.icon),
    };
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  return icon
    ? {
        color: textStyle.linkColor,
        icon: markdownLinkIconSource(icon),
        iconTintColor: textStyle.linkColor,
      }
    : undefined;
}

export function useEnrichedLinkVariants(
  urls: ReadonlyArray<string>,
  textStyle: NativeMarkdownTextStyle,
  fileChipHrefs?: readonly string[],
) {
  const mentionColor = mentionChipColor(useUniwindTheme());
  const links = useMemo(() => {
    const byUrl = new Map<string, EnrichedLinkPresentation>();
    for (const url of urls) {
      if (byUrl.has(url)) continue;
      const value = enrichedLinkPresentation(url, textStyle, mentionColor, fileChipHrefs?.includes(url));
      if (value) byUrl.set(url, value);
    }
    return byUrl;
  }, [urls, textStyle, mentionColor, fileChipHrefs]);
  const linkVariants = useMemo<MarkdownStyle["linkVariants"]>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          enrichedLinkVariantPattern(url),
          {
            pill: {
              borderColor: "transparent",
              borderWidth: 0,
              borderRadius: 6,
              paddingHorizontal: 5,
              paddingVertical: 2,
            },
            fontFamily: textStyle.fontFamily,
            color: link.color,
            underline: false,
            backgroundColor: "transparent",
          },
        ]),
      ),
    [links, textStyle],
  );
  const linkPillContent = useMemo<Record<string, LinkPillContent>>(
    () =>
      Object.fromEntries(
        [...links].map(([url, link]) => [
          url,
          {
            label: link.label,
            iconUri: Image.resolveAssetSource(link.icon)?.uri,
            iconTintColor: link.iconTintColor,
          },
        ]),
      ),
    [links],
  );
  return { linkVariants, linkPillContent };
}
