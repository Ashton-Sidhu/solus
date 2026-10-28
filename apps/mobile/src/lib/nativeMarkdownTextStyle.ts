// Adapted from T3 Code apps/mobile/src/features/threads/ThreadFeed.tsx (`useMarkdownStyles`, native text styles) (MIT, see UPSTREAM.md).
import { useMemo } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import type { NativeMarkdownTextStyle } from "../native/SelectableMarkdownText";
import { resolveNativeMarkdownTypography } from "./appearancePreferences";
import { themeAccentWithContrast } from "./mobileTheme";
import { useUniwindTheme } from "./useUniwindTheme";

/** T3's DM Sans faces (`src/lib/useFontFamily.ts`), bundled through `expo-font` in app.json.
 *  Each name is one weight, so the renderer asks for no `fontWeight`. */
const MARKDOWN_FONTS = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
} as const;

/** The file chip's slate blue, the desktop's `oklch(0.48 0.12 270)` (workspace.css). */
const FILE_CHIP_ACCENT = "#4458a1";

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
      fontFamily: MARKDOWN_FONTS.regular,
      headingFontFamily: MARKDOWN_FONTS.bold,
      boldFontFamily: MARKDOWN_FONTS.bold,
      // Desktop sets table headers at weight 500, not bold.
      tableHeaderFontFamily: MARKDOWN_FONTS.medium,
    };
    if (tone === "user") {
      const body = theme["--color-user-bubble-foreground"];
      return {
        ...shared,
        color: body,
        strongColor: body,
        mutedColor: body,
        linkColor: body,
        codeColor: theme["--color-md-user-code-text"],
        codeBackgroundColor: theme["--color-md-user-code-bg"],
        codeBlockBackgroundColor: theme["--color-md-user-fence-bg"],
        blockBorderColor: body,
        tableHeaderBackgroundColor: theme["--color-md-user-fence-bg"],
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
      codeColor: theme["--color-md-code-text"],
      codeBackgroundColor: theme["--color-md-code-bg"],
      codeBlockBackgroundColor: theme["--color-md-code-bg"],
      blockBorderColor: theme["--color-md-block-border"],
      // The table header fill (`--solus-surface-primary`): a 5% wash of ink
      // in light, 7% of white in dark.
      tableHeaderBackgroundColor: theme["--color-subtle-strong"],
      // Lifted on a dark canvas until it reads at 4.5:1.
      fileTextColor: themeAccentWithContrast(FILE_CHIP_ACCENT, [theme["--color-thread-canvas"]]),
      quoteMarkerColor: theme["--color-md-blockquote-border"],
      dividerColor: theme["--color-md-hr"],
    };
  }, [theme, tone, typography]);
}
