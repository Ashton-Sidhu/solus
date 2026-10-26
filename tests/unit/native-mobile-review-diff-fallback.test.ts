// A binary without the native lexers (Expo Go, or a build made before
// modules/solus-highlights) still highlights review diffs, through Shiki.
import { beforeAll, describe, expect, it, mock } from "bun:test";

import type { NativeReviewDiffRow } from "../../apps/mobile/src/features/diffs/nativeReviewDiffSurface";

mock.module("expo", () => ({ requireOptionalNativeModule: () => null }));

const { highlightNativeReviewDiffVisibleRows } = await import(
  "../../apps/mobile/src/features/diffs/nativeReviewDiffHighlighter"
);

const rows: ReadonlyArray<NativeReviewDiffRow> = [
  { kind: "line", id: "a", fileId: "file", content: "const a = 1;", change: "add", oldLineNumber: null, newLineNumber: 1 },
  { kind: "line", id: "b", fileId: "file", content: "export { a };", change: "add", oldLineNumber: null, newLineNumber: 2 },
];

function highlight(signal?: AbortSignal) {
  return highlightNativeReviewDiffVisibleRows({
    rows,
    files: [{ id: "file", path: "a.ts", language: "typescript", additions: 2, deletions: 0 }],
    scheme: "light",
    firstRowIndex: 0,
    lastRowIndex: 1,
    overscanRows: 0,
    signal,
  });
}

describe("review diff highlighting without the native module", () => {
  // Shiki keeps the rest of a line as one token once the line takes 500 ms;
  // the grammar compiles first so a loaded test run cannot reach that.
  beforeAll(() => highlight());

  it("colors the rows with Shiki once the promise settles", async () => {
    const result = highlight();
    expect(result).toBeInstanceOf(Promise);

    const { tokensByRowId, rowCount } = await result;
    expect(rowCount).toBe(2);
    expect(tokensByRowId.a?.map((token) => token.content).join("")).toBe("const a = 1;");
    expect(new Set(tokensByRowId.a?.map((token) => token.color)).size).toBeGreaterThan(1);
  });

  it("publishes no rows for a request the sheet aborted", async () => {
    // WHY: the visible range moved on; a stale patch must not mark rows as
    // highlighted, or they would never be highlighted for the new range.
    const controller = new AbortController();
    const result = highlight(controller.signal);
    controller.abort();
    expect(await result).toEqual({ tokensByRowId: {}, rowCount: 0 });
  });
});
