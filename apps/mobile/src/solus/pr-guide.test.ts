import { expect, it, vi } from "vite-plus/test";
import { projectPrGuide } from "./pr-guide";

vi.mock("./host-query", () => ({ hostQuery: vi.fn() }));
vi.mock("./host-command", () => ({ hostCommand: vi.fn() }));
vi.mock("./source-control", () => ({ prDiffSource: vi.fn() }));

it("keeps a previous head visible, with deletion excerpts on the old side of the diff", () => {
  const result = projectPrGuide(
    "new-head",
    {
      version: 1,
      key: "pr",
      title: "Review",
      summary: "",
      headSha: "old-head",
      baseSha: "base",
      generatedAt: "2026-10-01T12:00:00.000Z",
      sections: [
        {
          id: "section",
          title: "Cleanup",
          order: 1,
          significance: "core",
          explanation: "Removes the duplicate",
          files: [
            { path: "a.ts", additions: 0, deletions: 2, hunks: "@@ -10,2 +9,0 @@\n-old\n-copy" },
          ],
        },
      ],
    },
    null,
  );
  expect(result.currentHeadSha).toBe("new-head");
  expect(result.guide?.headSha).toBe("old-head");
  expect(result.guide?.stops[0]?.excerpts).toEqual([
    { path: "a.ts", side: "old", start: 10, end: 11, caption: "" },
  ]);
});
