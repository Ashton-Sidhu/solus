// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx (`useMarkdownStyles`, native text styles) (MIT, see UPSTREAM.md).
import { useMemo } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { NativeMarkdownTextStyle } from "../native/SelectableMarkdownText";
import { resolveNativeMarkdownTypography } from "./appearancePreferences";
import { MOBILE_FONTS } from "./typography";
import { useUniwindTheme } from "./useUniwindTheme";

/** `user` is text in the person's message bubble; `assistant` is everything else. */
export type MarkdownTone = "assistant" | "user";

/** T3's colors and type scale for the Enriched Markdown renderer, from Solus's theme. */
export function useNativeMarkdownTextStyle(tone: MarkdownTone): NativeMarkdownTextStyle {
  const { appearance } = useAppearancePreferences();
  const typography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const theme = useUniwindTheme();
  return useMemo(() => {
    const shared = {
      fontSize: typography.fontSize,
      lineHeight: typography.lineHeight,
      headingFontSizes: typography.headingFontSizes,
      fontFamily: MOBILE_FONTS.regular,
      headingFontFamily: MOBILE_FONTS.bold,
      boldFontFamily: MOBILE_FONTS.bold,
    };
    if (tone === "user") {
      const body = theme["--color-user-bubble-foreground"];
      return {
        ...shared,
        color: body,
        strongColor: body,
        mutedColor: body,
        linkColor: body,
        inlineCodeColor: theme["--color-user-bubble-foreground-muted"],
        codeColor: theme["--color-md-user-code-text"],
        codeBackgroundColor: theme["--color-md-user-code-bg"],
        codeBlockBackgroundColor: theme["--color-md-user-fence-bg"],
        fileTextColor: body,
        quoteMarkerColor: body,
        dividerColor: body,
      };
    }
    return {
      ...shared,
      color: theme["--color-md-body"],
      strongColor: theme["--color-md-strong"],
      mutedColor: theme["--color-md-body"],
      linkColor: theme["--color-md-link"],
      inlineCodeColor: theme["--color-foreground-secondary"],
      codeColor: theme["--color-md-code-text"],
      codeBackgroundColor: theme["--color-md-code-bg"],
      codeBlockBackgroundColor: theme["--color-md-code-bg"],
      fileTextColor: theme["--color-md-code-text"],
      quoteMarkerColor: theme["--color-md-blockquote-border"],
      dividerColor: theme["--color-md-hr"],
    };
  }, [theme, tone, typography]);
}
