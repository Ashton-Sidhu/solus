// Adapted from T3 Code apps/mobile/modules/t3-markdown-text/src/pendingCodeHighlight.test.ts (MIT, see apps/mobile/UPSTREAM.md).
import { expect, it } from "bun:test";
import { pendingCodeHighlight } from "../../apps/mobile/modules/t3-markdown-text/src/pendingCodeHighlight";

it("keeps completed colors and exact current text without retaining an edited tail", () => {
  // WHY: a streaming code block must not flash back to plain text for lines
  // that are already finished, and must never show stale text for the line
  // the agent is still writing.
  const colored = [
    [{ content: "const n = 1;", color: "red", fontStyle: 0 }],
    [{ content: "partial", color: "blue", fontStyle: 0 }],
  ];
  const result = pendingCodeHighlight(
    "const n = 1;\npartial",
    "const n = 1;\nchanged\nnext",
    colored,
  )!;
  expect(result[0]).toBe(colored[0]!);
  expect(result.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
    "const n = 1;\nchanged\nnext",
  );
  expect(
    result
      .slice(1)
      .flat()
      .every((token) => token.color === null),
  ).toBe(true);
  expect(
    pendingCodeHighlight("const n = 1;\npartial", "const n = 2;\npartial", colored),
  ).toBeNull();
  expect(pendingCodeHighlight("partial", "other", colored)).toBeNull();
});
