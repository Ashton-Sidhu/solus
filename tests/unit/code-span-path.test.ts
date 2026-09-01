import { describe, expect, test } from "bun:test";
import {
  basename,
  leadingDirs,
  parentDir,
} from "@solus/workspace-ui/components/ui/lib/code-span-path";

describe("file code-span chip path", () => {
  test("the parts a chip shows and hides rebuild the whole path", () => {
    // WHY: the chip has room for two segments, so copying a message used to
    // paste a partial path that no longer names a file. The copy-only part in
    // front of the label is what makes the selection carry the rest.
    for (const path of [
      "packages/workspace-ui/src/index.css",
      "src/App.svelte",
      "README.md",
      "./scripts/build.ts",
    ]) {
      expect(leadingDirs(path) + parentDir(path) + basename(path)).toBe(path);
    }
  });

  test("hides only what the chip cannot show", () => {
    expect(leadingDirs("packages/workspace-ui/src/index.css")).toBe(
      "packages/workspace-ui/",
    );
    expect(parentDir("packages/workspace-ui/src/index.css")).toBe("src/");
    expect(basename("packages/workspace-ui/src/index.css")).toBe("index.css");
  });

  test("a path the chip shows whole hides nothing", () => {
    expect(leadingDirs("src/App.svelte")).toBe("");
    expect(leadingDirs("README.md")).toBe("");
    expect(parentDir("README.md")).toBe("");
  });
});
