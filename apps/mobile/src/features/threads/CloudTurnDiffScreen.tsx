import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, useListened } from "../../app/app-context";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import type { ScreenProps } from "../../navigation/routes";
import { CODE_FONT } from "../../theme/tokens";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import { buildNativeReviewDiffData, NATIVE_REVIEW_DIFF_CONTENT_WIDTH } from "../review/nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "../review/reviewModel";
import { useNativeReviewDiffBridge } from "../review/useNativeReviewDiffBridge";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { cloudTurnDiffView } from "./lib/cloud-turn-diff-view";

const NO_IDS: readonly string[] = [];

/**
 * The changes of one turn of a session's copy from Solus Cloud
 * (docs/plans/portable-sessions-cloud.md, Phase 5B), on the native diff
 * surface that pull requests use. The Solus API reads the turn's patch at the
 * head it accepted; a patch over its cap answers counts only.
 */
export function CloudTurnDiffScreen({ route }: ScreenProps<"ThreadTurnDiff">) {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { sessionId, turnIndex } = route.params;
  const state = useListened(app.cloudHistory.changes, () => app.cloudHistory.diffOf(sessionId, turnIndex));
  useEffect(() => {
    void app.cloudHistory.loadDiff(sessionId, turnIndex);
  }, [app, sessionId, turnIndex]);
  const view = cloudTurnDiffView(state);
  const title = `Turn ${turnIndex + 1}`;

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: Platform.OS === "ios" ? insets.top : 0 }}>
      <NativeStackScreenOptions options={{ title, headerTitle: title, unstable_headerSubtitle: "Changes from Solus Cloud" }} />
      {view.kind === "loading" ? (
        <View className="items-center py-16">
          <ActivityIndicator colorClassName="accent-icon" />
          <Text className="mt-3 text-sm text-foreground-muted">Loading changes…</Text>
        </View>
      ) : view.kind === "message" ? (
        <View className="px-5 pt-4">
          <EmptyState
            title={view.title}
            detail={view.detail}
            {...(view.canRetry ? { actionLabel: "Try again", onAction: () => void app.cloudHistory.loadDiff(sessionId, turnIndex) } : {})}
          />
        </View>
      ) : (
        <TurnPatch patch={view.patch} sectionId={`cloud:${sessionId}:${turnIndex}`} bottomInset={insets.bottom} />
      )}
    </View>
  );
}

/** One turn's patch, read-only: no line comments and no viewed marks. */
function TurnPatch(props: { readonly patch: string; readonly sectionId: string; readonly bottomInset: number }) {
  const { patch, sectionId } = props;
  const parsed = useMemo(() => buildReviewParsedDiff(patch, sectionId), [patch, sectionId]);
  const data = useMemo(() => buildNativeReviewDiffData(parsed), [parsed]);
  const [collapsedIds, setCollapsedIds] = useState<readonly string[]>(NO_IDS);
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId,
    diff: patch,
    data,
    collapsedFileIds: collapsedIds,
    viewedFileIds: NO_IDS,
    selectedRowIds: NO_IDS,
    canHighlight: true,
  });
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const [NativeDiffView] = useState(() => resolveNativeReviewDiffView());

  // An app build without the diff surface, or a patch the parser cannot split into files: the text itself.
  if (!NativeDiffView || parsed.kind !== "files" || data.rows.length === 0) {
    return (
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: props.bottomInset + 24 }}>
        <Text selectable className="text-xs text-foreground" style={{ fontFamily: CODE_FONT }}>{patch}</Text>
      </ScrollView>
    );
  }
  return (
    <View className="flex-1" collapsable={false}>
      <NativeDiffView
        style={StyleSheet.absoluteFill}
        rowsJson={bridge.rowsJson}
        themeJson={bridge.themeJson}
        styleJson={bridge.styleJson}
        tokensPatchJson={bridge.tokensPatchJson}
        tokensResetKey={bridge.tokensResetKey}
        collapsedFileIdsJson={bridge.collapsedFileIdsJson}
        viewedFileIdsJson={bridge.viewedFileIdsJson}
        selectedRowIdsJson={bridge.selectedRowIdsJson}
        collapsedCommentIdsJson={bridge.collapsedCommentIdsJson}
        onDebug={bridge.onDebug}
        onToggleFile={(event) => {
          const id = event.nativeEvent.fileId;
          if (id) setCollapsedIds((ids) => (ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id]));
        }}
        appearanceScheme={themeAppearance}
        rowHeight={nativeReviewDiffStyle.rowHeight}
        contentWidth={NATIVE_REVIEW_DIFF_CONTENT_WIDTH}
        contentInsetBottom={props.bottomInset}
        contentResetKey={sectionId}
      />
    </View>
  );
}
