// Adapted from T3 Code apps/mobile/src/native/useEnrichedLinkVariants.ts (MIT, see UPSTREAM.md).
// File links and GitHub links only: no link customization, context chips, or skills.
import { useMemo } from "react";
import { Image, type ImageSourcePropType } from "react-native";
import type {
  LinkPillContent,
  MarkdownDocumentAsset,
  MarkdownStyle,
} from "react-native-enriched-markdown";

import { enrichedLinkVariantPattern } from "../lib/enrichedLinkPresentation";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

interface EnrichedLinkPresentation {
  readonly color: string;
  readonly label?: string;
  readonly icon: ImageSourcePropType;
  readonly iconTintColor?: string;
}

/** A file link is a pill with its type icon and file name; a GitHub link gets the GitHub mark. */
export function enrichedLinkPresentation(
  url: string,
  textStyle: NativeMarkdownTextStyle,
): EnrichedLinkPresentation | undefined {
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
  assets: ReadonlyArray<MarkdownDocumentAsset>,
  textStyle: NativeMarkdownTextStyle,
) {
  const links = useMemo(() => {
    const byUrl = new Map<string, EnrichedLinkPresentation>();
    for (const asset of assets) {
      if (asset.kind !== "link" || byUrl.has(asset.url)) continue;
      const value = enrichedLinkPresentation(asset.url, textStyle);
      if (value) byUrl.set(asset.url, value);
    }
    return byUrl;
  }, [assets, textStyle]);
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
