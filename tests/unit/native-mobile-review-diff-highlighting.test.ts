// Adapted from T3 Code apps/mobile/src/features/review/reviewDiffBridgeKeys.test.ts,
// reviewDiffHighlightScheduler.test.ts, and diffs/nativeReviewDiffHighlighter.test.ts
// (MIT, see apps/mobile/UPSTREAM.md). The budget tests run on the JavaScript
// engine only: a Bun test has no native Shiki engine to stand in for.
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";

import type { NativeReviewDiffRow } from "../../apps/mobile/src/features/diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../../apps/mobile/src/features/diffs/nativeReviewDiffTypes";
import { buildNativeReviewTokensResetKey } from "../../apps/mobile/src/features/review/reviewDiffBridgeKeys";
import { createReviewDiffHighlightScheduler } from "../../apps/mobile/src/features/review/reviewDiffHighlightScheduler";

const tokenization = {
  calls: [] as string[],
  afterCall: undefined as (() => void) | undefined,
};

// Record each Shiki call. The wrapper returns what Shiki returns, so another
// test file that loads Shiki in the same run sees the same results.
const shikiCore = { ...(await import("@shikijs/core")) };
mock.module("@shikijs/core", () => ({
  ...shikiCore,
  createHighlighterCore: async (...args: Parameters<typeof shikiCore.createHighlighterCore>) => {
    const highlighter = await shikiCore.createHighlighterCore(...args);
    return {
      ...highlighter,
      codeToTokensBase: (...input: Parameters<typeof highlighter.codeToTokensBase>) => {
        tokenization.calls.push(input[0]);
        const result = highlighter.codeToTokensBase(...input);
        tokenization.afterCall?.();
        return result;
      },
    };
  },
}));

const { highlightNativeReviewDiffVisibleRows } = await import(
  "../../apps/mobile/src/features/diffs/nativeReviewDiffHighlighter"
);

afterEach(() => {
  tokenization.calls = [];
  tokenization.afterCall = undefined;
});

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
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [TYPESCRIPT_FILE],
    scheme: "dark",
    engine: "javascript",
    firstRowIndex: 0,
    lastRowIndex: rows.length - 1,
    overscanRows: 0,
    maxRows: 100,
    alreadyHighlightedRowIds,
  });
}

describe("highlightNativeReviewDiffVisibleRows", () => {
  it("does not carry grammar state across hunk boundaries", async () => {
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
        id: "import-open",
        content: "import {",
        change: "context",
        oldLineNumber: 1,
        newLineNumber: 1,
      }),
      makeLine({
        id: "import-entry",
        content: "  Model,",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 2,
      }),
      makeHunk("hunk-2"),
      exportRow,
    ];

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([makeHunk("standalone-hunk"), exportRow]),
    ]);

    expect(highlighted.tokensByRowId[exportRow.id]).toEqual(standalone.tokensByRowId[exportRow.id]);
  });

  it("keeps grammar state across inline comment rows", async () => {
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

    const [withComment, contiguous] = await Promise.all([
      highlight([openingRow, commentRow, closingRow, trailingRow]),
      highlight([openingRow, closingRow, trailingRow]),
    ]);

    expect(withComment.tokensByRowId).toEqual(contiguous.tokensByRowId);
  });

  it("does not join unhighlighted rows across cached gaps", async () => {
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

    const [highlighted, standalone] = await Promise.all([
      highlight(rows, new Set(["template-close"])),
      highlight([trailingRow]),
    ]);

    expect(highlighted.tokensByRowId[trailingRow.id]).toEqual(
      standalone.tokensByRowId[trailingRow.id],
    );
  });

  it("keeps deletion grammar state out of addition rows", async () => {
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

    const [highlighted, standalone] = await Promise.all([
      highlight(rows),
      highlight([additionRow]),
    ]);

    expect(highlighted.tokensByRowId[additionRow.id]).toEqual(
      standalone.tokensByRowId[additionRow.id],
    );
  });
});

describe("highlighting budgets", () => {
  const engine = "javascript";
  const highlightRows = (rows: ReadonlyArray<NativeReviewDiffRow>, signal?: AbortSignal) =>
    highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 0,
      lastRowIndex: rows.length - 1,
      overscanRows: 0,
      signal,
    });

  const line = (id: number, content: string) =>
    makeLine({
      id: `line-${id}`,
      content,
      change: "add",
      oldLineNumber: null,
      newLineNumber: id,
    });

  it("still highlights a line at the length limit", async () => {
    const content = `// ${"x".repeat(997)}`;
    const result = await highlightRows([line(1, content)]);

    expect(tokenization.calls).toEqual([content]);
    expect(result.tokensByRowId["line-1"]?.some((token) => token.color !== null)).toBe(true);
  });

  it("keeps only the long line plain and resumes highlighting after it", async () => {
    const longLine = `${"x".repeat(1_001)} /*`;
    const rows = [
      line(1, "export const before = 1;"),
      line(2, longLine),
      { kind: "comment", id: "note", commentText: "Check this", fileId: TYPESCRIPT_FILE.id },
      line(3, "export const inside = 'x';"),
      makeHunk("next-hunk"),
      line(100, "export const after = 2;"),
    ] satisfies ReadonlyArray<NativeReviewDiffRow>;
    const result = await highlightRows(rows);

    expect(result.engine).toBe(engine);
    expect(Object.keys(result.tokensByRowId)).toEqual(["line-1", "line-2", "line-3", "line-100"]);
    expect(result.tokensByRowId["line-2"]).toEqual([
      { content: longLine, color: null, fontStyle: null },
    ]);
    for (const id of ["line-1", "line-3", "line-100"]) {
      expect(result.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
    }
    expect(tokenization.calls.some((code) => code.includes(longLine))).toBe(false);
  });

  it("highlights the rows after a long line the same regardless of the first window", async () => {
    const rows = [
      line(1, "export const before = 1;"),
      line(2, `const data = "${"x".repeat(1_050)}";`),
      line(3, "export const inside = 'x';"),
      line(4, "export const after = 2;"),
    ];
    const spanning = await highlightRows(rows);
    const afterLongLine = await highlightNativeReviewDiffVisibleRows({
      rows,
      files: [TYPESCRIPT_FILE],
      scheme: "dark",
      engine,
      firstRowIndex: 2,
      lastRowIndex: 3,
      overscanRows: 0,
    });

    for (const id of ["line-3", "line-4"]) {
      expect(spanning.tokensByRowId[id]?.some((token) => token.color !== null)).toBe(true);
      expect(afterLongLine.tokensByRowId[id]).toEqual(spanning.tokensByRowId[id]);
    }
  });

  it("preserves multiline grammar and row mapping across character-limited batches", async () => {
    const opening = line(1, "const message = `open");
    const body = Array.from({ length: 40 }, (_, index) => line(index + 2, "inside ".repeat(45)));
    const closing = line(42, "closed`; ");
    const trailing = line(43, "export const after = 2;");
    const result = await highlightRows([opening, ...body, closing, trailing]);
    const calls = [...tokenization.calls];
    const expected = await highlightRows([
      opening,
      { ...closing, newLineNumber: 2 },
      { ...trailing, newLineNumber: 3 },
    ]);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((code) => code.length <= 8_000)).toBe(true);
    expect(result.rowCount).toBe(43);
    for (const row of [opening, ...body, closing, trailing]) {
      expect(result.tokensByRowId[row.id]?.map((token) => token.content).join("")).toBe(
        row.content,
      );
    }
    expect(result.tokensByRowId[closing.id]).toEqual(expected.tokensByRowId[closing.id]);
    expect(result.tokensByRowId[trailing.id]).toEqual(expected.tokensByRowId[trailing.id]);
  });

  it("stops before later batches and publishes no partial result after cancellation", async () => {
    const controller = new AbortController();
    tokenization.afterCall = () => controller.abort();
    const rows = Array.from({ length: 30 }, (_, index) => line(index + 1, `// ${"x".repeat(400)}`));

    const result = await highlightRows(rows, controller.signal);

    expect(tokenization.calls).toHaveLength(1);
    expect(result.rowCount).toBe(0);
    expect(result.tokensByRowId).toEqual({});
  });
});
