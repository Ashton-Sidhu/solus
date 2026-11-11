// Adapted from T3 Code apps/mobile/src/features/files/SourceFileSurface.tsx (MIT, see UPSTREAM.md).
// The JavaScript surface only: T3's native review-diff canvas is not ported.
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import {
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Text as NativeText,
  View,
} from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import {
  resolveMobileCodeSurface,
  type ResolvedMobileCodeSurface,
} from "../../lib/appearancePreferences";
import { CODE_FONT } from "../../theme/tokens";
import type { ReviewHighlightedToken } from "../review/reviewHighlightedToken.types";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { selectableSourceHtml, selectableSourceScript } from "./lib/selectable-source-html";
import { useSourceHighlight } from "./sourceHighlightingState";

interface SourceFileSurfaceProps {
  readonly contents: string;
  readonly path: string;
  readonly onRefresh: () => void;
  /** The 1-based line to show; with `selecting`, the line selection mode opened at. */
  readonly line?: number | null;
  /** Shows the whole file as one selectable surface instead of numbered rows. */
  readonly selecting?: boolean;
  readonly onLongPressLine?: (line: number) => void;
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
  readonly onLongPress: () => void;
}) {
  const { onLongPress } = props;
  // Each row is its own text view, so selection cannot cross rows. A long
  // press opens the whole file as one selectable surface instead.
  return (
    <Pressable
      className="flex-row"
      style={{ minHeight: props.codeSurface.rowHeight }}
      onLongPress={onLongPress}
      accessibilityActions={[{ name: "longpress", label: "Select text" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") onLongPress();
      }}
    >
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
    </Pressable>
  );
});

/** Numbered, virtualized source lines, colored by the native lexers in the first render. */
export function SourceFileSurface(props: SourceFileSurfaceProps) {
  const { appearance, themeAppearance: theme, themeVariables } = useAppearancePreferences();
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

  const { onLongPressLine } = props;
  const renderLine = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <HighlightedSourceLine
        codeSurface={codeSurface}
        index={index}
        line={item}
        tokens={tokens?.[index] ?? null}
        wordBreak={codeWordBreak}
        onLongPress={() => onLongPressLine?.(index + 1)}
      />
    ),
    [codeSurface, codeWordBreak, onLongPressLine, tokens],
  );

  // Leaving selection mode remounts the rows; show the line it opened at.
  const listRef = useRef<FlatList<string>>(null);
  const targetIndex = props.line == null ? null : Math.min(Math.max(props.line - 1, 0), lines.length - 1);
  useEffect(() => {
    if (props.selecting || targetIndex === null) return;
    listRef.current?.scrollToIndex({ index: targetIndex, viewPosition: 0.5, animated: false });
  }, [props.selecting, targetIndex]);

  if (props.selecting) {
    const line = props.line ?? 1;
    if (Platform.OS === "android") {
      return (
        <View className="flex-1 bg-sheet">
          <WebView
            source={{
              html: selectableSourceHtml(normalizedContents, {
                foreground: themeVariables["--color-foreground"],
                selection: themeVariables["--color-focus"],
                fontSize: codeSurface.fontSize,
                rowHeight: codeSurface.rowHeight,
                wordBreak: codeWordBreak,
              }),
            }}
            originWhitelist={["about:*"]}
            injectedJavaScript={selectableSourceScript(line)}
            domStorageEnabled={false}
            cacheEnabled={false}
            setSupportMultipleWindows={false}
            onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
            style={{ flex: 1, backgroundColor: "transparent" }}
          />
        </View>
      );
    }
    const text = (
      <NativeText
        selectable
        className="text-foreground"
        style={{
          fontFamily: CODE_FONT,
          fontSize: codeSurface.fontSize,
          lineHeight: codeSurface.rowHeight,
          paddingHorizontal: 12,
        }}
      >
        {normalizedContents.replace(/\t/g, "    ")}
      </NativeText>
    );
    return (
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentOffset={{ x: 0, y: Math.max(0, (line - 1) * codeSurface.rowHeight - 200) }}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: codeSurface.rowHeight }}
      >
        {codeWordBreak ? text : <ScrollView horizontal bounces={false}>{text}</ScrollView>}
      </ScrollView>
    );
  }

  const list = (
    <FlatList
      ref={listRef}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={false} onRefresh={props.onRefresh} />}
      data={lines}
      extraData={tokens}
      keyExtractor={(_line, index) => String(index)}
      initialNumToRender={80}
      maxToRenderPerBatch={80}
      windowSize={12}
      // Wrapped rows have no fixed height; jump near the line, then to it.
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
        requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false }));
      }}
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
