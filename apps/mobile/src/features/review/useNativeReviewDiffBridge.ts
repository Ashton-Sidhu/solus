// Adapted from T3 Code apps/mobile/src/features/review/useNativeReviewDiffBridge.ts (MIT, see UPSTREAM.md).
// Solus has one theme, so there is no theme id; `onDebug` reads the typed debug payload.
import { useCallback, useMemo, useState } from "react";
import type { NativeSyntheticEvent } from "react-native";

import {
  isNativeReviewDiffDrawEvent,
  parseNativeReviewDiffDebugEvent,
  type NativeReviewDiffDebugPayload,
} from "../diffs/nativeReviewDiffSurface";
import { createNativeReviewDiffTheme, type NativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useNativeReviewDiffHighlighting } from "./useNativeReviewDiffHighlighting";
import { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";
import { useUniwindTheme } from "../../lib/useUniwindTheme";

export { buildNativeReviewTokensResetKey } from "./reviewDiffBridgeKeys";

export function useNativeReviewDiffBridge(input: {
  readonly threadKey: string | null;
  readonly sectionId: string | null;
  readonly diff: string | null | undefined;
  readonly data: NativeReviewDiffData;
  readonly collapsedFileIds: ReadonlyArray<string>;
  readonly viewedFileIds: ReadonlyArray<string>;
  readonly selectedRowIds: ReadonlyArray<string>;
  readonly canHighlight: boolean;
}) {
  const {
    canHighlight,
    collapsedFileIds,
    data,
    diff,
    sectionId,
    selectedRowIds,
    threadKey,
    viewedFileIds,
  } = input;
  const { nativeReviewDiffStyle } = useAppearanceCodeSurface();
  const { themeAppearance: scheme } = useAppearancePreferences();
  const appTheme = useUniwindTheme();
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const theme = useMemo(
    () => createNativeReviewDiffTheme(scheme, appTheme),
    [appTheme, scheme],
  );
  const rowsJson = useMemo(() => JSON.stringify(data.rows), [data.rows]);
  const collapsedFileIdsJson = useMemo(() => JSON.stringify(collapsedFileIds), [collapsedFileIds]);
  const viewedFileIdsJson = useMemo(() => JSON.stringify(viewedFileIds), [viewedFileIds]);
  const selectedRowIdsJson = useMemo(() => JSON.stringify(selectedRowIds), [selectedRowIds]);
  const collapsedCommentIdsJson = useMemo(
    () => JSON.stringify(Array.from(collapsedCommentIds)),
    [collapsedCommentIds],
  );
  const themeJson = useMemo(() => JSON.stringify(theme), [theme]);
  const styleJson = useMemo(() => JSON.stringify(nativeReviewDiffStyle), [nativeReviewDiffStyle]);
  const tokensResetKey = useMemo(
    () =>
      buildNativeReviewTokensResetKey({
        threadKey,
        sectionId,
        scheme,
        diff,
        fileCount: data.files.length,
        rowCount: data.rows.length,
      }),
    [data.files.length, data.rows.length, diff, scheme, sectionId, threadKey],
  );
  const { tokensPatchJson, updateVisibleRange } = useNativeReviewDiffHighlighting({
    files: data.files,
    rows: data.rows,
    scheme,
    resetKey: tokensResetKey,
    enabled: canHighlight,
  });

  const onDebug = useCallback(
    (event: NativeSyntheticEvent<NativeReviewDiffDebugPayload>) => {
      const payload = parseNativeReviewDiffDebugEvent(event.nativeEvent);
      if (
        isNativeReviewDiffDrawEvent(payload) &&
        payload.firstRowIndex !== undefined &&
        payload.lastRowIndex !== undefined
      ) {
        updateVisibleRange({
          firstRowIndex: payload.firstRowIndex,
          lastRowIndex: payload.lastRowIndex,
        });
      }
    },
    [updateVisibleRange],
  );

  const onToggleComment = useCallback(
    (event: NativeSyntheticEvent<{ readonly commentId?: string }>) => {
      const { commentId } = event.nativeEvent;
      if (!commentId) {
        return;
      }

      setCollapsedCommentIds((current) => {
        const next = new Set(current);
        if (next.has(commentId)) {
          next.delete(commentId);
        } else {
          next.add(commentId);
        }
        return next;
      });
    },
    [],
  );

  return {
    theme,
    rowsJson,
    collapsedFileIdsJson,
    collapsedCommentIdsJson,
    viewedFileIdsJson,
    selectedRowIdsJson,
    themeJson,
    styleJson,
    tokensPatchJson,
    tokensResetKey,
    onDebug,
    onToggleComment,
  };
}
