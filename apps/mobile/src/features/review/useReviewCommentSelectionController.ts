// Adapted from T3 Code apps/mobile/src/features/review/useReviewCommentSelectionController.ts (MIT, see UPSTREAM.md).
// The caller opens its own comment screen through `onOpenComment` (T3 navigates
// to its thread review sheet), and a section is any `{ id, title }` (T3 uses
// its checkpoint `ReviewSectionItem`). Plain arrays replace Effect.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { NativeSyntheticEvent } from "react-native";

import {
  buildReviewCommentTarget,
  clearReviewCommentTarget,
  formatReviewSelectedRangeLabel,
  getSelectedReviewCommentLines,
  setReviewCommentTarget,
  useReviewCommentTarget,
  type ReviewCommentTarget,
} from "./reviewCommentSelection";
import type {
  NativeReviewDiffData,
  NativeReviewDiffCommentTarget,
} from "./nativeReviewDiffAdapter";

/** The diff a comment belongs to: a pull request, one of its commits, or a guide stop. */
export interface ReviewCommentSection {
  readonly id: string;
  readonly title: string;
}

interface PendingNativeCommentSelection extends NativeReviewDiffCommentTarget {
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly rowId: string;
}

/**
 * A tap on a line selects it and calls `onOpenComment`. A long press starts a
 * range; the next tap in the same file ends it, and `selectionAction` then
 * offers "Comment on <range>". The selected range is the shared
 * `useReviewCommentTarget()` value that the comment screen reads.
 */
export function useReviewCommentSelectionController(input: {
  readonly section: ReviewCommentSection | null;
  readonly nativeReviewDiffData: NativeReviewDiffData;
  readonly onOpenComment: (target: ReviewCommentTarget) => void;
}) {
  const { nativeReviewDiffData, onOpenComment, section } = input;
  const activeCommentTarget = useReviewCommentTarget();
  const [pendingNativeCommentSelection, setPendingNativeCommentSelection] =
    useState<PendingNativeCommentSelection | null>(null);

  const selectedRowIds = useMemo(() => {
    if (
      activeCommentTarget &&
      activeCommentTarget.sectionTitle === section?.title &&
      activeCommentTarget.startIndex !== activeCommentTarget.endIndex
    ) {
      return getSelectedReviewCommentLines(activeCommentTarget).flatMap((line) => {
        const rowId = nativeReviewDiffData.rowIdByCommentLineId.get(line.id);
        return rowId ? [rowId] : [];
      });
    }

    return pendingNativeCommentSelection ? [pendingNativeCommentSelection.rowId] : [];
  }, [
    activeCommentTarget,
    nativeReviewDiffData.rowIdByCommentLineId,
    pendingNativeCommentSelection,
    section?.title,
  ]);

  const selectionAction = useMemo(() => {
    if (
      activeCommentTarget &&
      activeCommentTarget.sectionTitle === section?.title &&
      activeCommentTarget.startIndex !== activeCommentTarget.endIndex
    ) {
      return {
        title: `Comment on ${formatReviewSelectedRangeLabel(activeCommentTarget)}`,
        onOpenComment: () => onOpenComment(activeCommentTarget),
      };
    }

    if (
      pendingNativeCommentSelection &&
      pendingNativeCommentSelection.sectionTitle === section?.title
    ) {
      return {
        title: "Select range end",
        onOpenComment: null,
      };
    }

    return null;
  }, [activeCommentTarget, onOpenComment, pendingNativeCommentSelection, section?.title]);

  useEffect(() => {
    clearReviewCommentTarget();
    setPendingNativeCommentSelection(null);
  }, [section?.id]);

  useEffect(() => {
    if (activeCommentTarget === null) {
      setPendingNativeCommentSelection(null);
    }
  }, [activeCommentTarget]);

  const onPressLine = useCallback(
    (
      event: NativeSyntheticEvent<{
        readonly rowId?: string;
        readonly gesture?: "tap" | "longPress";
      }>,
    ) => {
      if (!section) {
        return;
      }

      const { rowId, gesture } = event.nativeEvent;
      if (!rowId) {
        return;
      }

      const target = nativeReviewDiffData.commentTargetsByRowId.get(rowId);
      if (!target) {
        return;
      }

      if (gesture === "longPress") {
        clearReviewCommentTarget();
        setPendingNativeCommentSelection({
          ...target,
          sectionId: section.id,
          sectionTitle: section.title,
          rowId,
        });
        return;
      }

      if (
        pendingNativeCommentSelection &&
        pendingNativeCommentSelection.sectionTitle === section.title &&
        pendingNativeCommentSelection.filePath === target.filePath
      ) {
        setReviewCommentTarget(
          buildReviewCommentTarget(
            {
              sectionTitle: pendingNativeCommentSelection.sectionTitle,
              sectionId: pendingNativeCommentSelection.sectionId,
              filePath: pendingNativeCommentSelection.filePath,
              lines: pendingNativeCommentSelection.lines,
            },
            pendingNativeCommentSelection.lineIndex,
            target.lineIndex,
          ),
        );
        return;
      }

      setPendingNativeCommentSelection(null);
      const lineTarget: ReviewCommentTarget = {
        sectionTitle: section.title,
        sectionId: section.id,
        filePath: target.filePath,
        lines: target.lines,
        startIndex: target.lineIndex,
        endIndex: target.lineIndex,
      };
      setReviewCommentTarget(lineTarget);
      onOpenComment(lineTarget);
    },
    [
      nativeReviewDiffData.commentTargetsByRowId,
      onOpenComment,
      pendingNativeCommentSelection,
      section,
    ],
  );

  const clearSelection = useCallback(() => {
    clearReviewCommentTarget();
    setPendingNativeCommentSelection(null);
  }, []);

  return {
    selectedRowIds,
    selectionAction,
    onPressLine,
    clearSelection,
  };
}
