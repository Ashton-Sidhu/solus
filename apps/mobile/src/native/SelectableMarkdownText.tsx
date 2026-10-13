// Adapted from T3 Code apps/mobile/src/native/SelectableMarkdownText.tsx (MIT, see UPSTREAM.md).
import { useMemo } from "react";
import { Platform } from "react-native";

import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useUniwindTheme } from "../lib/useUniwindTheme";
import { MobileEnrichedMarkdownText } from "./EnrichedMarkdownText";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";

export type {
  MarkdownImageRenderer,
  MarkdownImageRequest,
  MarkdownImageSourceResolver,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";

export function SelectableMarkdownText(props: SelectableMarkdownTextProps) {
  const theme = useUniwindTheme();
  const selectionColor = themeColorWithAlpha(theme["--color-focus"], 0.32);
  const selectionHandleColor = theme["--color-focus"];
  const textStyle = useMemo(
    () =>
      Platform.OS === "android"
        ? { selectionColor, selectionHandleColor, ...props.textStyle }
        : props.textStyle,
    [props.textStyle, selectionColor, selectionHandleColor],
  );
  return <MobileEnrichedMarkdownText {...props} textStyle={textStyle} />;
}
