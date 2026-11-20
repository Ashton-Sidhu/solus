import type { ToolCallCode } from "@solus/client-core/tool-call-code";
import { Text as NativeText, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useNativeMarkdownTextStyle } from "../../lib/nativeMarkdownTextStyle";
import { CODE_FONT } from "../../theme/tokens";
import { useSourceHighlight } from "../files/sourceHighlightingState";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { ToolExpandedBody } from "./thread-work-log-presentation";

/** An open tool call: its input as code, then the text the code does not hold. */
export function ToolCallDetail(props: { readonly body: ToolExpandedBody | null }) {
  if (!props.body) return null;
  const { code, text } = props.body;
  return (
    <View className="gap-1.5">
      {code ? <ToolCallCodeBlock code={code} /> : null}
      {text ? (
        <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/** The chat's code fence, with the language above the code as desktop shows
 *  it. Long lines wrap so a phone reads the whole command without a sideways
 *  scroll. */
function ToolCallCodeBlock(props: { readonly code: ToolCallCode }) {
  const style = useNativeMarkdownTextStyle("assistant");
  const { codeSurface } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const { tokens } = useSourceHighlight({
    path: "",
    language: props.code.language,
    contents: props.code.code,
    theme: themeAppearance,
  });

  return (
    <View
      className="overflow-hidden rounded-[10px] border"
      style={{ backgroundColor: style.codeBlockBackgroundColor, borderColor: style.blockBorderColor }}
    >
      <NativeText
        className="px-3 pt-2 text-3xs uppercase tracking-wider"
        style={{ color: style.mutedColor, fontFamily: CODE_FONT, opacity: 0.6 }}
      >
        {props.code.language}
      </NativeText>
      <NativeText
        selectable
        className="px-3 pb-2.5 pt-1"
        style={{
          color: style.codeColor,
          fontFamily: CODE_FONT,
          fontSize: codeSurface.fontSize,
          lineHeight: codeSurface.rowHeight,
        }}
      >
        {tokens
          ? tokens.map((line, lineIndex) => (
              <NativeText key={lineIndex}>
                {lineIndex > 0 ? "\n" : ""}
                {line.map((token, tokenIndex) => (
                  <NativeText
                    key={tokenIndex}
                    style={{
                      color: token.color ?? style.codeColor,
                      fontStyle: (token.fontStyle ?? 0) & 1 ? "italic" : "normal",
                      fontWeight: (token.fontStyle ?? 0) & 2 ? "700" : "400",
                    }}
                  >
                    {token.content}
                  </NativeText>
                ))}
              </NativeText>
            ))
          : props.code.code}
      </NativeText>
    </View>
  );
}
