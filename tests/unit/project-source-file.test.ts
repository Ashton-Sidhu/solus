import { describe, expect, test } from "bun:test";
import {
  projectSourceFileName,
  projectSourcePath,
} from "../../src/renderer/components/pickers/lib/project-source-file";

describe("project source files", () => {
  test("uses portable visible file names for each source kind", () => {
    expect(projectSourceFileName("API / rollout", "doc")).toBe("API _ rollout.md");
    expect(projectSourceFileName("System map", "diagram")).toBe("System map.json");
    expect(projectSourceFileName("", "plan")).toBe("plan.md");
  });

  test("joins a selected directory without duplicate separators", () => {
    expect(projectSourcePath("/repo/docs/", "plan.md")).toBe("/repo/docs/plan.md");
    expect(projectSourcePath("C:\\repo\\docs\\", "plan.md")).toBe("C:\\repo\\docs/plan.md");
  });
});
