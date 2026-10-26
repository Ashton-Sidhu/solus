// Adapted from T3 Code apps/mobile/src/features/review/useNativeReviewDiffHighlighting.ts (MIT, see UPSTREAM.md).
import { useEffect, useRef, useState } from "react";

import type { HighlightScheme } from "../../lib/highlights";
import {
  highlightNativeReviewDiffVisibleRows,
  type NativeReviewDiffHighlightedRows,
} from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";

import {
  createReviewDiffHighlightScheduler,
  type NativeReviewVisibleRange,
} from "./reviewDiffHighlightScheduler";

function createEmptyTokenPatch(resetKey: string): string {
  return JSON.stringify({ resetKey, tokensByRowId: {} });
}

function isReviewDiffDebugLoggingEnabled(): boolean {
  // `__DEV__` is not defined outside the React Native runtime, for example in tests.
  return "__DEV__" in globalThis ? __DEV__ : false;
}

interface ReviewDiffDiagnosticDetails {
  readonly error: unknown;
  readonly resetKey: string;
  readonly scheme: HighlightScheme;
  readonly firstRowIndex: number;
  readonly lastRowIndex: number;
}

function logReviewDiffDiagnostic(message: string, details?: ReviewDiffDiagnosticDetails): void {
  if (!isReviewDiffDebugLoggingEnabled()) {
    return;
  }

  if (details) {
    console.log(`[review-sheet] ${message}`, details);
    return;
  }

  console.log(`[review-sheet] ${message}`);
}

export function useNativeReviewDiffHighlighting(input: {
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly scheme: HighlightScheme;
  readonly resetKey: string;
  readonly enabled: boolean;
}) {
  const { enabled, files, resetKey, rows, scheme } = input;
  const highlightedRowIdsRef = useRef<Set<string>>(new Set());
  const [visibleRange, setVisibleRange] = useState<NativeReviewVisibleRange>({
    firstRowIndex: 0,
    lastRowIndex: 80,
  });
  const visibleChunkIndexRef = useRef(0);
  const [tokensPatchJson, setTokensPatchJson] = useState(() => createEmptyTokenPatch(resetKey));
  const [scheduler] = useState(() => createReviewDiffHighlightScheduler(setVisibleRange));

  useEffect(() => {
    scheduler.reset();
    highlightedRowIdsRef.current = new Set();
    visibleChunkIndexRef.current = 0;
    setVisibleRange({ firstRowIndex: 0, lastRowIndex: 80 });
    setTokensPatchJson(createEmptyTokenPatch(resetKey));
    return () => scheduler.cancel();
  }, [enabled, resetKey, rows.length, scheduler]);

  useEffect(() => {
    if (!enabled || rows.length === 0) {
      return;
    }

    const abortController = new AbortController();
    const requestRange = visibleRange;
    const publish = (result: NativeReviewDiffHighlightedRows) => {
      if (abortController.signal.aborted || result.rowCount === 0) {
        return;
      }

      for (const rowId of Object.keys(result.tokensByRowId)) {
        highlightedRowIdsRef.current.add(rowId);
      }

      const chunkIndex = visibleChunkIndexRef.current;
      visibleChunkIndexRef.current += 1;
      setTokensPatchJson(
        JSON.stringify({ resetKey, chunkIndex, tokensByRowId: result.tokensByRowId }),
      );
    };
    const reportFailure = (error: Error) => {
      if (!abortController.signal.aborted) {
        logReviewDiffDiagnostic("native visible highlight failed", {
          error,
          resetKey,
          scheme,
          firstRowIndex: requestRange.firstRowIndex,
          lastRowIndex: requestRange.lastRowIndex,
        });
      }
    };

    // The native lexers answer in the call; only the Shiki fallback is awaited.
    try {
      const result = highlightNativeReviewDiffVisibleRows({
        files,
        rows,
        scheme,
        firstRowIndex: requestRange.firstRowIndex,
        lastRowIndex: requestRange.lastRowIndex,
        alreadyHighlightedRowIds: highlightedRowIdsRef.current,
        signal: abortController.signal,
      });
      if (result instanceof Promise) void result.then(publish, reportFailure);
      else publish(result);
    } catch (error) {
      reportFailure(error instanceof Error ? error : new Error(String(error)));
    }

    return () => abortController.abort();
  }, [enabled, files, resetKey, rows, scheme, visibleRange]);

  return {
    tokensPatchJson,
    updateVisibleRange: scheduler.update,
  };
}
