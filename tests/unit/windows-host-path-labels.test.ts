import { describe, expect, test } from "bun:test";
import { abbreviateHome, projectDirLabel } from "@solus/workspace-ui/lib/paths";
import { isPathUnderRoot } from "@solus/workspace-ui/lib/sessionUtils";
import { projectRelativePath, toAbsoluteFilePaths } from "@solus/workspace-ui/lib/changedFiles";
import { shortWorktreePath } from "@solus/workspace-ui/components/conversation/lib/worktree-offer";
import { markdownImagePath } from "@solus/workspace-ui/components/conversation/lib/markdown-image";

describe("a Windows host path read on any client", () => {
  test("a project row names the folder, not the whole path", () => {
    // WHY: split on `/` only, a Windows project showed `C:\code\scratch` where every other row shows its folder name.
    expect(projectDirLabel("C:\\code\\scratch")).toBe("scratch");
    expect(projectDirLabel("C:/code/scratch/")).toBe("scratch");
    expect(projectDirLabel("/Users/sidhu/scratch")).toBe("scratch");
  });

  test("a Windows home folder shortens to ~", () => {
    // WHY: a Windows user's paths read as `C:\Users\<name>\…` everywhere a macOS one reads `~/…`.
    expect(abbreviateHome("C:\\Users\\ashto\\code\\x")).toBe("~\\code\\x");
    expect(abbreviateHome("d:/Users/ashto/x")).toBe("~/x");
    expect(abbreviateHome("C:\\code\\x")).toBe("C:\\code\\x");
  });

  test("a file in a Windows project is under its root", () => {
    // WHY: plans and works are scoped to the open projects by this test; a `/`-only prefix test dropped every Windows item.
    expect(isPathUnderRoot("C:\\code\\scratch\\docs\\plan.md", "C:\\code\\scratch")).toBe(true);
    expect(isPathUnderRoot("c:/code/scratch", "C:\\code\\scratch\\")).toBe(true);
    expect(isPathUnderRoot("C:\\code\\scratch2\\a.md", "C:\\code\\scratch")).toBe(false);
  });

  test("a changed file reads relative to a Windows project and joins back in its separator", () => {
    // WHY: the changed-files list showed full Windows paths, and opening one built `C:\repo/src/a.ts`.
    expect(projectRelativePath("C:\\code\\scratch\\src\\a.ts", "C:\\code\\scratch")).toBe("src/a.ts");
    expect(projectRelativePath("C:\\code\\scratch", "C:\\code\\scratch")).toBe("C:\\code\\scratch");
    expect(toAbsoluteFilePaths(["src/a.ts", "D:\\other\\b.ts"], "C:\\code\\scratch")).toEqual([
      "C:\\code\\scratch\\src\\a.ts",
      "D:\\other\\b.ts",
    ]);
  });

  test("a worktree offer names a Windows worktree by its last two folders", () => {
    // WHY: with no `/` in the path the card printed the whole Windows layout it exists to hide.
    expect(shortWorktreePath("C:\\code\\scratch\\.git\\solus\\worktrees\\fix-login")).toBe("…\\worktrees\\fix-login");
  });

  test("a Markdown image resolves against a Windows working directory", () => {
    // WHY: `C:\x.png` matched the URL-scheme test and showed no image, and a relative one resolved to `/C:/repo/…`.
    expect(markdownImagePath("C:\\shots\\x.png", "C:\\code\\scratch")).toBe("C:\\shots\\x.png");
    expect(markdownImagePath("./shots/x.png", "C:\\code\\scratch")).toBe("C:\\code\\scratch\\shots\\x.png");
    expect(markdownImagePath("https://example.com/x.png", "C:\\code\\scratch")).toBeNull();
  });
});
