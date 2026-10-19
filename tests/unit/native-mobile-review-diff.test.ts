// Adapted from T3 Code apps/mobile/src/features/review/reviewModel.test.ts,
// reviewWordDiffs.test.ts, and nativeReviewDiffAdapter.test.ts (MIT, see apps/mobile/UPSTREAM.md).
// The checkpoint section tests are not ported (no T3 thread state). Solus has
// one theme, so the theme tests read its light and dark palettes.
import { describe, expect, it, spyOn } from "bun:test";

import { getMobileThemeVariables } from "../../apps/mobile/src/lib/mobileTheme";
import {
  buildNativeReviewDiffData,
  buildNativeReviewSnippetRows,
  createNativeReviewDiffTheme,
  getCachedNativeReviewDiffData,
  type BuildNativeReviewDiffDataInput,
} from "../../apps/mobile/src/features/review/nativeReviewDiffAdapter";
import type { ReviewInlineComment } from "@solus/contracts/review-comment";
import {
  buildReviewParsedDiff,
  getReviewFilePreviewState,
  type ReviewRenderableFile,
} from "../../apps/mobile/src/features/review/reviewModel";
import { guideExcerptPatch } from "../../apps/mobile/src/features/prs/lib/pull-request-guide-tour";
import * as ReviewWordDiffs from "../../apps/mobile/src/features/review/reviewWordDiffs";
import {
  applyDiffRangesToTokens,
  computeWordAltDiffRanges,
} from "../../apps/mobile/src/features/review/reviewWordDiffs";

function makeRenderableFile(
  input: Partial<ReviewRenderableFile> & Pick<ReviewRenderableFile, "path">,
): ReviewRenderableFile {
  return {
    id: input.path,
    cacheKey: input.path,
    previousPath: null,
    changeType: "new",
    additions: 0,
    deletions: 0,
    languageHint: null,
    additionLines: [],
    deletionLines: [],
    rows: [],
    ...input,
  };
}

describe("buildReviewParsedDiff", () => {
  it.each([
    ["a/example.ts", "a/example.ts"],
    ["b/example.ts", "b/example.ts"],
    ["a/before.ts", "b/after.ts"],
  ])("preserves repository paths from %s to %s", (previousPath, path) => {
    const parsed = buildReviewParsedDiff(
      [
        `diff --git a/${previousPath} b/${path}`,
        ...(previousPath === path
          ? []
          : ["similarity index 50%", `rename from ${previousPath}`, `rename to ${path}`]),
        `--- a/${previousPath}`,
        `+++ b/${path}`,
        "@@ -1 +1 @@",
        "-before",
        "+after",
      ].join("\n"),
      "repository-paths",
    );
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files[0]).toMatchObject({
      path,
      previousPath: previousPath === path ? null : previousPath,
      additions: 1,
      deletions: 1,
    });
  });

  it("builds renderable rows from a unified patch", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1,2 +1,3 @@",
        "-const before = 1;",
        "+const after = 2;",
        "+console.log(after);",
        " return true;",
      ].join("\n"),
      "unit",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.fileCount).toBe(1);
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.files[0]).toMatchObject({
      path: "apps/mobile/src/a.ts",
      additions: 2,
      deletions: 1,
    });
    expect(parsed.files[0]?.rows).toEqual([
      expect.objectContaining({ kind: "hunk", header: "@@ -1,2 +1,3 @@" }),
      expect.objectContaining({
        kind: "line",
        change: "delete",
        oldLineNumber: 1,
        newLineNumber: null,
        content: "const before = 1;",
        comparison: { change: "add", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 1,
        content: "const after = 2;",
        comparison: { change: "delete", tokenIndex: 0 },
      }),
      expect.objectContaining({
        kind: "line",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 2,
        content: "console.log(after);",
        comparison: null,
      }),
      expect.objectContaining({
        kind: "line",
        change: "context",
        oldLineNumber: 2,
        newLineNumber: 3,
        content: "return true;",
        comparison: null,
      }),
    ]);
  });

  it("treats truncated patches as partial diffs instead of failing", () => {
    const parsed = buildReviewParsedDiff(
      [
        "diff --git a/apps/mobile/src/a.ts b/apps/mobile/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/apps/mobile/src/a.ts",
        "+++ b/apps/mobile/src/a.ts",
        "@@ -1 +1,2 @@",
        " const before = 1;",
        "+const after = 2;",
        "",
        "[truncated]",
      ].join("\n"),
      "unit-truncated",
    );

    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") {
      return;
    }

    expect(parsed.notice).toContain("server size cap");
    expect(parsed.fileCount).toBe(1);
    expect(parsed.files[0]?.rows[0]).toMatchObject({
      kind: "hunk",
      header: "@@ -1,1 +1,2 @@",
    });
  });

  it("suppresses preview for non-text file formats", () => {
    const preview = getReviewFilePreviewState(
      makeRenderableFile({
        path: "apps/mobile/assets/icon.png",
      }),
    );

    expect(preview).toMatchObject({
      kind: "suppressed",
      reason: "non-text",
      title: "Non-text file",
      actionLabel: null,
    });
  });

  it("suppresses large diffs until explicitly requested", () => {
    const preview = getReviewFilePreviewState(
      makeRenderableFile({
        path: "apps/mobile/src/big.ts",
        rows: Array.from({ length: 401 }, (_, index) => ({
          kind: "line" as const,
          id: `line-${index}`,
          change: "add" as const,
          oldLineNumber: null,
          newLineNumber: index + 1,
          content: `const line${index} = ${index};`,
          additionTokenIndex: index,
          deletionTokenIndex: null,
          comparison: null,
        })),
      }),
    );

    expect(preview).toMatchObject({
      kind: "suppressed",
      reason: "large",
      title: "Large diff",
      actionLabel: "Load diff",
    });
  });
});

describe("computeWordAltDiffRanges", () => {
  it("joins adjacent word replacements across a single shared separator", () => {
    const ranges = computeWordAltDiffRanges({
      deletionLine: "old old",
      additionLine: "new new",
    });

    expect(ranges.deletion).toEqual([{ start: 0, end: "old old".length }]);
    expect(ranges.addition).toEqual([{ start: 0, end: "new new".length }]);
  });

  it("skips inline word diffs for long lines", () => {
    const longDeletion = `const before = "${"a".repeat(1_001)}";`;
    const longAddition = `const after = "${"b".repeat(1_001)}";`;

    const ranges = computeWordAltDiffRanges({
      deletionLine: longDeletion,
      additionLine: longAddition,
    });

    expect(ranges.deletion).toEqual([]);
    expect(ranges.addition).toEqual([]);
  });
});

describe("applyDiffRangesToTokens", () => {
  it("splits highlighted fragments out of syntax tokens", () => {
    const tokens = [
      {
        content: "const before = 1;",
        color: "#fff",
        fontStyle: null,
      },
    ];
    const nextTokens = applyDiffRangesToTokens(tokens, [{ start: 6, end: 12 }]);

    expect(nextTokens).toEqual([
      {
        content: "const ",
        color: "#fff",
        fontStyle: null,
        diffHighlight: false,
      },
      {
        content: "before",
        color: "#fff",
        fontStyle: null,
        diffHighlight: true,
      },
      {
        content: " = 1;",
        color: "#fff",
        fontStyle: null,
        diffHighlight: false,
      },
    ]);
  });

  it("skips exhausted ranges when later tokens start after the last range", () => {
    const tokens = [
      {
        content: "a",
        color: "#fff",
        fontStyle: null,
      },
      {
        content: "b",
        color: "#fff",
        fontStyle: null,
      },
    ];

    const nextTokens = applyDiffRangesToTokens(tokens, [{ start: 0, end: 1 }]);

    expect(nextTokens).toEqual([
      {
        content: "a",
        color: "#fff",
        fontStyle: null,
        diffHighlight: true,
      },
      {
        content: "b",
        color: "#fff",
        fontStyle: null,
      },
    ]);
  });
});

const parsedDiff = buildReviewParsedDiff(
  [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -1 +1 @@",
    "-const before = 1;",
    "+const after = 2;",
  ].join("\n"),
  "native-review-cache-test",
);

describe("buildNativeReviewSnippetRows", () => {
  it("preserves selected code and change types without inventing line numbers", () => {
    const rows = buildNativeReviewSnippetRows({
      id: "selection",
      diff: "  unchanged\r\n-  before\r\n+  after\r\n",
    });
    expect(
      rows.map((row) => [row.content, row.change, row.oldLineNumber, row.newLineNumber]),
    ).toEqual([
      [" unchanged", "context", null, null],
      ["  before", "delete", null, null],
      ["  after", "add", null, null],
    ]);
  });

  it("leaves full patches, unrecognized text, and non-diff code to their existing renderers", () => {
    for (const diff of ["@@ -1 +1 @@\n-old\n+new", "--- a/file\n+++ b/file", "plain text", ""]) {
      expect(buildNativeReviewSnippetRows({ id: "selection", diff })).toEqual([]);
    }
    expect(
      buildNativeReviewSnippetRows({ id: "code", diff: "+value", fenceLanguage: "typescript" }),
    ).toEqual([]);
  });
});

function makeComment(text: string): ReviewInlineComment {
  return {
    id: "comment-1",
    sectionId: "git:working-tree",
    sectionTitle: "Dirty worktree",
    filePath: "example.ts",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "-1",
    text,
    diff: "@@ -1,1 +1,0 @@\n-const before = 1;",
  };
}

function buildInput(comments: BuildNativeReviewDiffDataInput["comments"]) {
  return { parsedDiff, comments } satisfies BuildNativeReviewDiffDataInput;
}

function filesPatch(paths: ReadonlyArray<string>) {
  return paths
    .map((path) =>
      [
        `diff --git a/${path} b/${path}`,
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -1,2 +1,2 @@",
        '-const first = renderPanel({ label: "before", enabled: true });',
        '-const second = renderPanel({ label: "before", enabled: true });',
        '+const first = renderPanel({ label: "after", enabled: true });',
        '+const second = renderPanel({ label: "after", enabled: true });',
      ].join("\n"),
    )
    .join("\n");
}

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("getCachedNativeReviewDiffData", () => {
  it.each([true, false])(
    "preserves available diff rows before a notice (has excerpt: %s)",
    (hasExcerpt) => {
      if (parsedDiff.kind !== "files") throw new Error("Expected a parsed file diff");
      const notice = "This file preview was truncated.";
      const result = buildNativeReviewDiffData({
        parsedDiff: {
          ...parsedDiff,
          files: parsedDiff.files.map((file) => ({
            ...file,
            rows: hasExcerpt ? file.rows : [],
            notice,
          })),
        },
      });
      const original = buildNativeReviewDiffData({ parsedDiff });
      expect(result.rows.slice(0, -1)).toEqual(
        hasExcerpt ? original.rows : original.rows.filter((row) => row.kind === "file"),
      );
      expect(result.rows.at(-1)).toMatchObject({ kind: "notice", text: notice });
    },
  );

  it("reuses the row model for equivalent empty comment arrays", () => {
    const first = getCachedNativeReviewDiffData(buildInput([]));
    const second = getCachedNativeReviewDiffData(buildInput([]));

    expect(second).toBe(first);
  });

  it("reuses equivalent comment contents and invalidates changed comments", () => {
    const first = getCachedNativeReviewDiffData(buildInput([makeComment("First")]));
    const equivalent = getCachedNativeReviewDiffData(buildInput([makeComment("First")]));
    const changed = getCachedNativeReviewDiffData(buildInput([makeComment("Changed")]));

    expect(equivalent).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.rows.find((row) => row.kind === "comment")?.commentText).toBe("Changed");
  });

  it("reuses source rows and word matching when a file comment changes", () => {
    const diff = buildReviewParsedDiff(filesPatch(["example.ts", "second.ts"]), "comment-reuse");
    const matchWords = spyOn(ReviewWordDiffs, "computeWordAltDiffRanges");
    try {
      const base = getCachedNativeReviewDiffData({ parsedDiff: diff });
      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(base.rows.filter((row) => row.wordDiffRanges?.length)).toHaveLength(8);
      const firstComment = makeComment("First file comment");
      const secondComment = {
        ...makeComment("Second file comment"),
        id: "comment-2",
        filePath: "second.ts",
      };
      const first = getCachedNativeReviewDiffData({
        parsedDiff: diff,
        comments: [firstComment, secondComment],
      });
      const changed = getCachedNativeReviewDiffData({
        parsedDiff: diff,
        comments: [{ ...firstComment, text: "Changed first comment" }, secondComment],
      });

      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(changed.files).toBe(base.files);
      expect(changed.commentTargetsByRowId).toBe(base.commentTargetsByRowId);
      expect(changed.rowIdByCommentLineId).toBe(base.rowIdByCommentLineId);
      expect(changed.rows.find((row) => row.id === secondComment.id)).toBe(
        first.rows.find((row) => row.id === secondComment.id),
      );
      const sourceRows = changed.rows.filter((row) => row.kind !== "comment");
      for (const [index, row] of sourceRows.entries()) {
        expect(row).toBe(base.rows[index]);
      }
      const removed = getCachedNativeReviewDiffData({ parsedDiff: diff, comments: [] });
      expect(removed.rows).toEqual(base.rows);
      expect(matchWords).toHaveBeenCalledTimes(4);
      expect(first.rows.find((row) => row.id === firstComment.id)?.commentText).toBe(
        "First file comment",
      );
    } finally {
      matchWords.mockRestore();
    }
  });

  it("updates comment titles and locations without changing source coordinates", () => {
    const diff = buildReviewParsedDiff(filesPatch(["example.ts", "second.ts"]), "comment-metadata");
    const comment = makeComment("Review this line");
    const first = getCachedNativeReviewDiffData({ parsedDiff: diff, comments: [comment] });
    const renamed = getCachedNativeReviewDiffData({
      parsedDiff: diff,
      comments: [{ ...comment, sectionTitle: "Branch comparison" }],
    });
    expect(renamed.rows.find((row) => row.id === comment.id)?.commentSectionTitle).toBe(
      "Branch comparison",
    );
    const moved = getCachedNativeReviewDiffData({
      parsedDiff: diff,
      comments: [{ ...comment, filePath: "second.ts", endIndex: 99, rangeLabel: "+2" }],
    });
    const commentIndex = moved.rows.findIndex((row) => row.id === comment.id);
    expect(moved.rows[commentIndex]).toMatchObject({
      kind: "comment",
      filePath: "second.ts",
      commentRangeLabel: "+2",
    });
    expect(moved.rows[commentIndex - 1]).toMatchObject({
      kind: "line",
      change: "add",
      newLineNumber: 2,
    });
    expect(moved.rows.filter((row) => row.kind !== "comment")).toEqual(
      first.rows.filter((row) => row.kind !== "comment"),
    );
    expect(first.rows.find((row) => row.id === comment.id)?.commentSectionTitle).toBe(
      "Dirty worktree",
    );
  });

  it("keeps cached IDs and targets local to each parsed section and file layout", () => {
    const original = filesPatch(["example.ts", "second.ts"]);
    const variants = [
      buildReviewParsedDiff(original, "first-section"),
      buildReviewParsedDiff(original, "second-section"),
      buildReviewParsedDiff(
        filesPatch(["inserted.ts", "example.ts", "second.ts"]),
        "first-section",
      ),
      buildReviewParsedDiff(filesPatch(["second.ts", "example.ts"]), "first-section"),
      buildReviewParsedDiff(filesPatch(["example.ts"]), "first-section"),
      buildReviewParsedDiff(
        original.replaceAll("@@ -1,2 +1,2 @@", "@@ -7,2 +12,2 @@"),
        "first-section",
      ),
    ];
    for (const diff of [...variants, variants[0]!]) {
      const input = { parsedDiff: diff, comments: [makeComment("Coordinates")] };
      expect(getCachedNativeReviewDiffData(input)).toEqual(buildNativeReviewDiffData(input));
    }
  });
});

describe("createNativeReviewDiffTheme", () => {
  it("serializes every native color as cross-platform opaque hex", () => {
    for (const appearance of ["light", "dark"] as const) {
      const theme = createNativeReviewDiffTheme(appearance, getMobileThemeVariables(appearance));
      for (const color of Object.values(theme)) {
        expect(color).toMatch(/^#[\da-f]{6}$/i);
      }
      expect(contrastRatio(theme.hunkText, theme.hunkBackground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)(
    // WHY: desktop's diff (`--solus-diff-*-vivid`) is the status green and red,
    // so an added line is the same colour on the phone as on desktop.
    "paints additions and deletions in the status green and red in %s",
    (appearance) => {
      const variables = getMobileThemeVariables(appearance);
      const theme = createNativeReviewDiffTheme(appearance, variables);
      expect([theme.addText, theme.addBar]).toEqual([variables["--color-adaptive-emerald-600-400"], variables["--color-adaptive-emerald-600-400"]]);
      expect([theme.deleteText, theme.deleteBar]).toEqual([variables["--color-adaptive-rose-600-400"], variables["--color-adaptive-rose-600-400"]]);
      // A changed row is a wash of its hue over the page, between the page and the hue.
      for (const [wash, hue] of [[theme.addBackground, theme.addText], [theme.deleteBackground, theme.deleteText]] as const) {
        expect(contrastRatio(wash, theme.background)).toBeLessThan(contrastRatio(hue, theme.background));
        expect(wash).not.toBe(theme.background);
      }
    },
  );

  it.each(["light", "dark"] as const)(
    // Desktop paints diffs on the page colour (`--solus-diff-surface`), not the code block tint.
    "paints the diff on the screen and composites translucent app colors onto it in %s",
    (appearance) => {
      const variables = {
        ...getMobileThemeVariables(appearance),
        "--color-screen": "#101214FF",
        "--color-md-code-bg": "#20222480",
        "--color-md-code-text": "#E3E2E6FF",
        "--color-foreground-muted": "#C7C5D080",
        "--color-border": "#44464F80",
      };
      const theme = createNativeReviewDiffTheme(appearance, variables);
      expect(theme.background).toBe("#101214");
      expect(theme.headerBackground).toBe(theme.background);
      expect(theme.text).toBe("#e3e2e6");
      expect(theme.mutedText).toBe("#6c6c72");
      expect(theme.border).toBe("#2a2c32");
      for (const color of Object.values(theme)) {
        expect(color).toMatch(/^#[\da-f]{6}$/i);
      }
    },
  );
});

// Git quotes `café menu.ts` as `"a/caf\303\251 menu.ts"`. The host sends the
// real path for review comments and file stats, so the phone must name the
// file with the real path too, or nothing matches it.
describe("quoted git paths", () => {
  const quoted = "caf\\303\\251 menu.ts";

  it("names a quoted non-ASCII file and its rename source with the host paths", () => {
    const patch = [
      `diff --git "a/old ${quoted}" "b/${quoted}"`,
      "similarity index 90%",
      `rename from "old ${quoted}"`,
      `rename to "${quoted}"`,
      `--- "a/old ${quoted}"`,
      `+++ "b/${quoted}"`,
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const parsed = buildReviewParsedDiff(patch, "quoted-paths");
    expect(parsed.kind).toBe("files");
    if (parsed.kind !== "files") return;
    expect(parsed.files[0]?.path).toBe("café menu.ts");
    expect(parsed.files[0]?.previousPath).toBe("old café menu.ts");
  });

  it("keeps a guide excerpt path with a backslash", () => {
    const patch = guideExcerptPatch({ path: "dir\\file.ts", hunks: "@@ -1 +1 @@\n-a\n+b" });
    const parsed = buildReviewParsedDiff(patch, "backslash-path");
    if (parsed.kind !== "files") throw new Error(`expected files, got ${parsed.kind}`);
    expect(parsed.files[0]?.path).toBe("dir\\file.ts");
  });
});
