import { resolveFileIcon, fileIconColor } from "@solus/client-core/file-icons";
// Adapted from T3 Code apps/mobile/src/native/useEnrichedLinkVariants.ts (MIT, see UPSTREAM.md).
// File links, `@path` mentions, and web link icons: no link customization,
// context chips, or skills. A mention wears T3's mention context chip.
import { replyImage } from "@solus/client-core/reply-images";
import { webLinkIcon } from "@solus/client-core/web-link-icon";
import { useEffect, useMemo, useState } from "react";
import { Image, type ImageSourcePropType } from "react-native";
import type { LinkPillContent, MarkdownStyle } from "react-native-enriched-markdown";

import { enrichedLinkVariantPattern, mentionChipColor } from "../lib/enrichedLinkPresentation";
import { fileMentionPath } from "../lib/fileMentions";
import { markdownFileIconSource } from "../lib/markdownFileIcons";
import { markdownLinkIconSource } from "../lib/markdownLinkIcons";
import { resolveMarkdownLinkIcon, resolveMarkdownLinkPresentation } from "../lib/markdownLinks";
import { fileBasename } from "../lib/markdownLinkTargets";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

interface EnrichedLinkPresentation {
  readonly color: string;
  readonly label?: string;
  readonly icon: ImageSourcePropType;
  readonly iconTintColor?: string;
  readonly faviconUrl?: string;
}

const globeIcon = require("../../assets/link-icons/globe.png");
const faviconRequests = new Map<string, Promise<boolean>>();

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
  appearance: "light" | "dark" = "light",
): EnrichedLinkPresentation | undefined {
  if (fileChip) return { color: textStyle.fileTextColor, label: replyImage(url).label, icon: markdownFileIconSource("image"), iconTintColor: fileIconColor("image", appearance) };
  const mentionPath = fileMentionPath(url);
  if (mentionPath !== null)
    return {
      color: mentionColor,
      label: fileBasename(mentionPath),
      icon: markdownFileIconSource(resolveFileIcon(mentionPath).token),
      iconTintColor: fileIconColor(resolveFileIcon(mentionPath).token, appearance),
    };
  const link = resolveMarkdownLinkPresentation(url);
  if (link.kind === "file")
    return {
      color: textStyle.fileTextColor,
      label: link.label,
      icon: markdownFileIconSource(link.icon),
      iconTintColor: fileIconColor(link.icon, appearance),
    };
  const icon = link.kind === "external" ? resolveMarkdownLinkIcon(link.host) : null;
  if (icon) return {
    color: textStyle.linkColor,
    icon: markdownLinkIconSource(icon),
    iconTintColor: textStyle.color,
  };
  if (link.kind !== "external") return undefined;
  const webIcon = webLinkIcon(link.href);
  if (webIcon?.kind === "favicon") return {
    color: textStyle.linkColor,
    icon: { uri: webIcon.url },
    faviconUrl: webIcon.url,
  };
  return { color: textStyle.linkColor, icon: globeIcon, iconTintColor: textStyle.color };
}

export function useEnrichedLinkVariants(
  urls: ReadonlyArray<string>,
  textStyle: NativeMarkdownTextStyle,
  fileChipHrefs?: readonly string[],
) {
  const { themeVariables, themeAppearance } = useAppearancePreferences();
  const mentionColor = mentionChipColor(themeVariables);
  const links = useMemo(() => {
    const byUrl = new Map<string, EnrichedLinkPresentation>();
    for (const url of urls) {
      if (byUrl.has(url)) continue;
      const value = enrichedLinkPresentation(url, textStyle, mentionColor, fileChipHrefs?.includes(url), themeAppearance);
      if (value) byUrl.set(url, value);
    }
    return byUrl;
  }, [urls, textStyle, mentionColor, fileChipHrefs, themeAppearance]);
  const [failedFavicons, setFailedFavicons] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    for (const link of links.values()) {
      const faviconUrl = link.faviconUrl;
      if (!faviconUrl) continue;
      let request = faviconRequests.get(faviconUrl);
      if (!request) {
        request = Image.prefetch(faviconUrl).catch(() => false);
        faviconRequests.set(faviconUrl, request);
      }
      void request.then((loaded) => {
        if (loaded || cancelled) return;
        setFailedFavicons((previous) => {
          if (previous.has(faviconUrl)) return previous;
          return new Set([...previous, faviconUrl]);
        });
      });
    }
    return () => { cancelled = true; };
  }, [links]);
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
              paddingHorizontal: 7,
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
            iconUri: Image.resolveAssetSource(link.faviconUrl && failedFavicons.has(link.faviconUrl) ? globeIcon : link.icon)?.uri,
            iconTintColor: link.faviconUrl && failedFavicons.has(link.faviconUrl) ? textStyle.color : link.iconTintColor,
          },
        ]),
      ),
    [links, failedFavicons, textStyle.color],
  );
  return { linkVariants, linkPillContent };
}
