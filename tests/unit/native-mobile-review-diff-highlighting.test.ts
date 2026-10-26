// Adapted from T3 Code apps/mobile/src/features/review/reviewDiffBridgeKeys.test.ts,
// reviewDiffHighlightScheduler.test.ts, and diffs/nativeReviewDiffHighlighter.test.ts
// (MIT, see apps/mobile/UPSTREAM.md). The segmentation tests run on the real
// lexers: the WebAssembly build stands in for the native module.
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

import type { NativeReviewDiffRow } from "../../apps/mobile/src/features/diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../../apps/mobile/src/features/diffs/nativeReviewDiffTypes";
import { buildNativeReviewTokensResetKey } from "../../apps/mobile/src/features/review/reviewDiffBridgeKeys";
import { createReviewDiffHighlightScheduler } from "../../apps/mobile/src/features/review/reviewDiffHighlightScheduler";
import { createWasmHighlightsModule } from "./helpers/native-mobile-highlights";

const nativeModule = createWasmHighlightsModule();
mock.module("expo", () => ({ requireOptionalNativeModule: () => nativeModule }));

const { highlightNativeReviewDiffVisibleRows } = await import(
  "../../apps/mobile/src/features/diffs/nativeReviewDiffHighlighter"
);

describe("native review diff bridge", () => {
  it("changes reset keys when the rendered diff identity changes", () => {
    const input = {
      threadKey: "env:thread",
      sectionId: "turn:2",
      scheme: "dark" as const,
      diff: "diff --git a/a.ts b/a.ts",
      fileCount: 1,
      rowCount: 4,
    };

    const resetKey = buildNativeReviewTokensResetKey(input);

    expect(
      buildNativeReviewTokensResetKey({ ...input, diff: "diff --git a/b.ts b/b.ts" }),
    ).not.toBe(resetKey);
    expect(buildNativeReviewTokensResetKey({ ...input, rowCount: 5 })).not.toBe(resetKey);
    expect(buildNativeReviewTokensResetKey({ ...input, diff: null })).not.toBe(resetKey);
  });
});

describe("review diff highlighting while scrolling", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("keeps requesting new rows during gradual scrolling through a large diff", () => {
    const request = mock();
    const scheduler = createReviewDiffHighlightScheduler(request);
    for (let firstRowIndex = 1; firstRowIndex <= 1_674; firstRowIndex++) {
      scheduler.update({ firstRowIndex, lastRowIndex: firstRowIndex + 80 });
      jest.advanceTimersByTime(16);
    }
    expect(request.mock.calls.length).toBeGreaterThan(100);
    jest.advanceTimersByTime(150);
    expect(request).toHaveBeenLastCalledWith({ firstRowIndex: 1_674, lastRowIndex: 1_754 });
  });

  it("highlights the settled viewport even below the movement threshold", () => {
    const request = mock();
    const scheduler = createReviewDiffHighlightScheduler(request);
    scheduler.update({ firstRowIndex: 2, lastRowIndex: 82 });
    jest.advanceTimersByTime(100);
    scheduler.update({ firstRowIndex: 3, lastRowIndex: 83 });
    jest.advanceTimersByTime(100);
    expect(request).not.toHaveBeenCalled();
    jest.advanceTimersByTime(50);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ firstRowIndex: 3, lastRowIndex: 83 });
  });

  it("does not let repeated draw events starve the settled refresh", () => {
    const request = mock();
    const scheduler = createReviewDiffHighlightScheduler(request);
    for (let i = 0; i < 10; i++) {
      scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
      jest.advanceTimersByTime(30);
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ firstRowIndex: 1, lastRowIndex: 81 });
  });

  it("requests large jumps and reverse scrolling immediately without stale timers", () => {
    const request = mock();
    const scheduler = createReviewDiffHighlightScheduler(request);
    scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
    scheduler.update({ firstRowIndex: 1_000, lastRowIndex: 1_080 });
    scheduler.update({ firstRowIndex: 0, lastRowIndex: 80 });
    jest.runAllTimers();
    expect(request.mock.calls).toEqual([
      [{ firstRowIndex: 1_000, lastRowIndex: 1_080 }],
      [{ firstRowIndex: 0, lastRowIndex: 80 }],
    ]);
  });

  it("cancels pending work on disposal and resets the range for a new diff", () => {
    const request = mock();
    const scheduler = createReviewDiffHighlightScheduler(request);
    scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
    scheduler.cancel();
    jest.runAllTimers();
    expect(request).not.toHaveBeenCalled();
    scheduler.update({ firstRowIndex: 1_000, lastRowIndex: 1_080 });
    request.mockClear();
    scheduler.update({ firstRowIndex: 1_001, lastRowIndex: 1_081 });
    scheduler.reset();
    jest.runAllTimers();
    expect(request).not.toHaveBeenCalled();
    scheduler.update({ firstRowIndex: 1, lastRowIndex: 81 });
    expect(request).not.toHaveBeenCalled();
    jest.advanceTimersByTime(150);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ firstRowIndex: 1, lastRowIndex: 81 });
  });
});

const TYPESCRIPT_FILE: NativeReviewDiffFile = {
  id: "file-1",
  path: "example.ts",
  language: "typescript",
  additions: 0,
  deletions: 0,
};

function makeLine(
  input: Pick<NativeReviewDiffRow, "id" | "content" | "change" | "oldLineNumber" | "newLineNumber">,
): NativeReviewDiffRow {
  return {
    kind: "line",
    fileId: TYPESCRIPT_FILE.id,
    ...input,
  };
}

function makeHunk(id: string): NativeReviewDiffRow {
  return {
    kind: "hunk",
    id,
    fileId: TYPESCRIPT_FILE.id,
    text: "@@",
  };
}

function highlight(
  rows: ReadonlyArray<NativeReviewDiffRow>,
  alreadyHighlightedRowIds?: ReadonlySet<string>,
) {
  const result = highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
    maxRows: 100,
    alreadyHighlightedRowIds,
  });
  // The native lexers answer in the call; the sheet publishes in the same effect.
  if (result instanceof Promise) throw new Error("expected tokens in the call");
  return result;
}

describe("highlightNativeReviewDiffVisibleRows", () => {
  it("does not carry grammar state across hunk boundaries", () => {
    const exportRow = makeLine({
      id: "export-row",
      content: "export async function run() {}",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 100,
    });
    const rows = [
      makeHunk("hunk-1"),
      makeLine({
        id: "template-open",
        content: "const message = `open",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      }),
      makeHunk("hunk-2"),
      exportRow,
    ];

    const highlighted = highlight(rows);
    const standalone = highlight([makeHunk("standalone-hunk"), exportRow]);

    expect(highlighted.tokensByRowId[exportRow.id]).toEqual(standalone.tokensByRowId[exportRow.id]);
  });

  it("keeps grammar state across inline comment rows", () => {
    const openingRow = makeLine({
      id: "template-open",
      content: "const message = `open",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const closingRow = makeLine({
      id: "template-close",
      content: "closed`;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 2,
    });
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const commentRow: NativeReviewDiffRow = {
      kind: "comment",
      id: "comment-1",
      fileId: TYPESCRIPT_FILE.id,
      commentText: "Review note",
    };

    const withComment = highlight([openingRow, commentRow, closingRow, trailingRow]);
    const contiguous = highlight([openingRow, closingRow, trailingRow]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
    expect(withComment.tokensByRowId[closingRow.id]?.[0]?.color).toBe(
      withComment.tokensByRowId[openingRow.id]?.at(-1)?.color,
    );
  });

  it("does not join unhighlighted rows across cached gaps", () => {
    const trailingRow = makeLine({
      id: "trailing-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 3,
    });
    const rows = [
      makeLine({
        id: "template-open",
        content: "const message = `open",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
      }),
      makeLine({
        id: "template-close",
        content: "closed`;",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
      }),
      trailingRow,
    ];

    const highlighted = highlight(rows, new Set(["template-close"]));
    const standalone = highlight([trailingRow]);

    expect(highlighted.tokensByRowId[trailingRow.id]).toEqual(
      standalone.tokensByRowId[trailingRow.id],
    );
  });

  it("keeps deletion grammar state out of addition rows", () => {
    const additionRow = makeLine({
      id: "addition-row",
      content: "export const answer = 42;",
      change: "add",
      oldLineNumber: null,
      newLineNumber: 1,
    });
    const rows = [
      makeLine({
        id: "deletion-row",
        content: "const removed = `open",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
      }),
      additionRow,
    ];

    const highlighted = highlight(rows);
    const standalone = highlight([additionRow]);

    expect(highlighted.tokensByRowId[additionRow.id]).toEqual(
      standalone.tokensByRowId[additionRow.id],
    );
  });
});
