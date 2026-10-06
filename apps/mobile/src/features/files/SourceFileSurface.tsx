// Adapted from T3 Code apps/mobile/src/features/files/SourceFileSurface.tsx (MIT, see UPSTREAM.md).
// The JavaScript surface only: T3's native review-diff canvas is not ported.
import { memo, useCallback, useMemo } from "react";
import {
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  Text as NativeText,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../lib/appearancePreferences";
import { CODE_FONT } from "../../theme/tokens";
import type { ReviewHighlightedToken } from "../review/shikiReviewHighlighter";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useSourceHighlight } from "./sourceHighlightingState";

interface SourceFileSurfaceProps {
  readonly contents: string;
  readonly path: string;
  readonly onRefresh: () => void;
}

function renderVisibleWhitespace(value: string): string {
  const expandedTabs = value.replace(/\t/g, "    ");
  return expandedTabs.replace(/^( +)/, (leading) => leading.replaceAll(" ", " "));
}

const HighlightedSourceLine = memo(function HighlightedSourceLine(props: {
  readonly codeSurface: ResolvedMobileCodeSurface;
  readonly index: number;
  readonly line: string;
  readonly tokens: ReadonlyArray<ReviewHighlightedToken> | null;
  readonly wordBreak: boolean;
}) {
  return (
    <View className="flex-row" style={{ minHeight: props.codeSurface.rowHeight }}>
      <NativeText
        className="select-none pr-3 text-right text-foreground-tertiary"
        style={{
          width: props.codeSurface.gutterWidth,
          fontFamily: CODE_FONT,
          fontSize: props.codeSurface.lineNumberFontSize,
          lineHeight: props.codeSurface.rowHeight,
        }}
      >
        {props.index + 1}
      </NativeText>
      <NativeText
        selectable
        selectionColorClassName={Platform.OS === "android" ? "accent-focus/32" : undefined}
        numberOfLines={props.wordBreak ? undefined : 1}
        className="flex-1 font-normal text-foreground"
        style={{
          fontFamily: CODE_FONT,
          fontSize: props.codeSurface.fontSize,
          lineHeight: props.codeSurface.rowHeight,
          minWidth: props.wordBreak ? undefined : 320,
        }}
      >
        {props.tokens && props.tokens.length > 0
          ? (() => {
              let offset = 0;
              return props.tokens.map((token) => {
                const start = offset;
                offset += token.content.length;

                const fontWeight =
                  token.fontStyle !== null && (token.fontStyle & 2) === 2
                    ? ("700" as const)
                    : ("400" as const);
                const fontStyle =
                  token.fontStyle !== null && (token.fontStyle & 1) === 1
                    ? ("italic" as const)
                    : ("normal" as const);

                return (
                  <NativeText
                    key={`${start}:${token.content.length}:${token.color ?? ""}`}
                    selectable
                    selectionColorClassName={
                      Platform.OS === "android" ? "accent-focus/32" : undefined
                    }
                    style={{
                      color: token.color ?? undefined,
                      fontFamily: CODE_FONT,
                      fontWeight,
                      fontStyle,
                    }}
                  >
                    {token.content.length > 0 ? renderVisibleWhitespace(token.content) : " "}
                  </NativeText>
                );
              });
            })()
          : renderVisibleWhitespace(props.line || " ")}
      </NativeText>
    </View>
  );
});

/** Numbered, virtualized source lines, colored by Shiki once highlighting finishes. */
export function SourceFileSurface(props: SourceFileSurfaceProps) {
  const { appearance, themeAppearance: theme } = useAppearancePreferences();
  const codeSurface = useMemo(
    () => resolveMobileCodeSurface(appearance.codeFontSize),
    [appearance.codeFontSize],
  );
  const codeWordBreak = appearance.codeWordBreak;
  const normalizedContents = useMemo(
    () => props.contents.replace(/\r\n?/g, "\n"),
    [props.contents],
  );
  const lines = useMemo(() => normalizedContents.split("\n"), [normalizedContents]);
  const { status, tokens } = useSourceHighlight({
    path: props.path,
    contents: normalizedContents,
    theme,
  });

  const renderLine = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <HighlightedSourceLine
        codeSurface={codeSurface}
        index={index}
        line={item}
        tokens={tokens?.[index] ?? null}
        wordBreak={codeWordBreak}
      />
    ),
    [codeSurface, codeWordBreak, tokens],
  );

  const list = (
    <FlatList
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={false} onRefresh={props.onRefresh} />}
      data={lines}
      extraData={tokens}
      keyExtractor={(_line, index) => String(index)}
      initialNumToRender={80}
      maxToRenderPerBatch={80}
      windowSize={12}
      {...(codeWordBreak
        ? {}
        : {
            getItemLayout: (_data: ArrayLike<string> | null | undefined, index: number) => ({
              length: codeSurface.rowHeight,
              offset: codeSurface.rowHeight * index,
              index,
            }),
          })}
      contentContainerStyle={{
        minWidth: codeWordBreak ? undefined : "100%",
        paddingBottom: codeSurface.rowHeight,
        paddingTop: 8,
      }}
      renderItem={renderLine}
    />
  );

  return (
    <View className="relative flex-1 bg-sheet">
      {status === "error" ? (
        <View className="border-b border-border bg-card px-4 py-2">
          <Text className="text-2xs font-t3-medium uppercase text-foreground-muted">
            Plain text
          </Text>
        </View>
      ) : null}
      {codeWordBreak ? (
        list
      ) : (
        <ScrollView horizontal bounces={false} className="flex-1">
          {list}
        </ScrollView>
      )}
    </View>
  );
}
