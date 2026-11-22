import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestReviewGuideExcerpt } from "@t3tools/contracts";
import { excerptRows, fileDiffRows, rowsToPatch } from "@t3tools/client-runtime/review-guide-tour";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { resolveNativeReviewDiffView } from "../../diffs/nativeReviewDiffSurface";
import { buildNativeReviewDiffData } from "../../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../../review/reviewModel";
import { useNativeReviewDiffBridge } from "../../review/useNativeReviewDiffBridge";
import { useAppearanceCodeSurface } from "../../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import { PullRequestMarkdown } from "../PullRequestMarkdown";

const EMPTY_IDS: readonly string[] = [];

type GuideDiffProps = {
  readonly excerpt: PullRequestReviewGuideExcerpt;
  readonly file: FileDiffMetadata | undefined;
  readonly loading: boolean;
  readonly onOpen: () => void;
} | {
  readonly path: string;
  readonly patch: string;
};

export function ReviewGuideExcerpt(props: GuideDiffProps) {
  const excerpt = "excerpt" in props ? props.excerpt : null;
  const path = "path" in props ? props.path : props.excerpt.path;
  const onOpen = "onOpen" in props ? props.onOpen : undefined;
  const slice = "patch" in props ? props.patch : excerptPatch(props.file, props.excerpt);
  const sectionId = `guide:${path}:${excerpt?.start ?? "file"}`;
  const gt = useGT();
  const messages = useMessages();
  const { nativeReviewDiffStyle, codeWordBreak } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const data = (() => {
    const parsed = buildNativeReviewDiffData(
      buildReviewParsedDiff(slice, sectionId, messages),
    );
    return {
      ...parsed,
      rows: parsed.rows.filter((row) => row.kind !== "file" && row.kind !== "hunk"),
    };
  })();
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId,
    diff: slice,
    data,
    collapsedFileIds: EMPTY_IDS,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: true,
  });
  const [measuredHeight, setMeasuredHeight] = useState<{ key: string; height: number } | null>(
    null,
  );
  const measurementKey = `${slice}:${codeWordBreak}:${nativeReviewDiffStyle.rowHeight}`;
  const [NativeDiff] = useState(() => resolveNativeReviewDiffView());
  return (
    <View className="gap-3">
      {excerpt?.caption.trim() ? (
        <PullRequestMarkdown lineBreaks={false} markdown={excerpt.caption} />
      ) : null}
      <View className="overflow-hidden rounded-lg border border-border-subtle">
        <Pressable
          disabled={!onOpen}
          accessibilityRole={onOpen ? "button" : undefined}
          accessibilityLabel={excerpt ? gt("Open {path} at line {line} in full diff", {
            path: excerpt.path,
            line: excerpt.start,
          }) : path}
          onPress={onOpen}
          className="min-h-11 flex-row items-center gap-3 border-b border-border-subtle px-3 py-2 active:opacity-60"
        >
          <Text
            className="min-w-0 flex-1 text-xs text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {path}
          </Text>
          {excerpt && <Text className="text-2xs text-foreground-muted">
            {excerpt.start}–{excerpt.end}
          </Text>}
          {onOpen && <SymbolView name="arrow.up.right" size={13} tintColorClassName="accent-icon-muted" />}
        </Pressable>
        {NativeDiff && data.rows.length ? (
          <View
            style={{
              height:
                measuredHeight?.key === measurementKey
                  ? measuredHeight.height
                  : data.rows.length * nativeReviewDiffStyle.rowHeight,
            }}
          >
            <NativeDiff
              scrollEnabled={false}
              bounces={false}
              appearanceScheme={themeAppearance}
              rowHeight={nativeReviewDiffStyle.rowHeight}
              contentWidth={2800}
              style={{ flex: 1 }}
              rowsJson={bridge.rowsJson}
              themeJson={bridge.themeJson}
              styleJson={bridge.styleJson}
              tokensPatchJson={bridge.tokensPatchJson}
              tokensResetKey={bridge.tokensResetKey}
              onDebug={(event) => {
                bridge.onDebug(event);
                const { message, contentHeight } = event.nativeEvent;
                if (message === "metrics" && typeof contentHeight === "number") {
                  setMeasuredHeight((current) =>
                    current?.key === measurementKey && current.height === contentHeight
                      ? current
                      : { key: measurementKey, height: contentHeight },
                  );
                }
              }}
              {...(onOpen ? { onPressLine: onOpen } : {})}
            />
          </View>
        ) : (
          <Text className="p-3 text-xs text-foreground-muted">
            {"loading" in props && props.loading
              ? gt("Loading {path}…", { path })
              : !excerpt ? slice : gt("{location} is not in the loaded diff.", {
                  location: `${excerpt.path}:${excerpt.start}–${excerpt.end}`,
                })}
          </Text>
        )}
      </View>
    </View>
  );
}

function excerptPatch(
  file: FileDiffMetadata | undefined,
  excerpt: PullRequestReviewGuideExcerpt,
): string {
  if (!file) return "";
  try {
    return rowsToPatch(
      excerpt.path,
      file.prevName ?? excerpt.path,
      excerptRows(fileDiffRows(file), excerpt),
    );
  } catch {
    return "";
  }
}
