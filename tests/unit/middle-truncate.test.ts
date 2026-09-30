import { describe, expect, test } from "bun:test";
import { splitForMiddleTruncate } from "@solus/workspace-ui/components/ui/middle-truncate/middle-truncate";

describe("middle truncation split", () => {
  test("the two halves rebuild the whole string", () => {
    // WHY: both halves render as real text, so copy, selection and screen
    // readers get the full value only if nothing is dropped at the cut.
    const value = "fix/cache-main-20260918-180825";
    const split = splitForMiddleTruncate(value);
    expect(split).not.toBeNull();
    expect(split!.head + split!.tail).toBe(value);
  });

  test("a path keeps its short last segment whole", () => {
    // WHY: the file name is the part that identifies a path.
    expect(splitForMiddleTruncate("packages/workspace-ui/src/App.svelte")).toEqual({
      head: "packages/workspace-ui/src/",
      tail: "App.svelte",
    });
  });

  test("a long last segment keeps a fixed tail so the head can still show", () => {
    // WHY: a branch like `sidhu/fix-cache-main-20260918-180825` must keep the
    // date suffix that tells it from its siblings, without pinning the whole
    // segment and pushing the prefix out.
    const split = splitForMiddleTruncate("sidhu/fix-cache-main-20260918-180825");
    expect(split?.tail).toBe("918-180825");
  });

  test("a short value is not split", () => {
    // WHY: an ellipsis in front of most of the string hides nothing useful.
    expect(splitForMiddleTruncate("main")).toBeNull();
    expect(splitForMiddleTruncate("main-branch")).toBeNull();
  });

  test("an explicit tail overrides the path rule", () => {
    expect(splitForMiddleTruncate("a/very/long/path/name.ts", 3)?.tail).toBe(".ts");
  });

  test("the cut never splits a surrogate pair", () => {
    // WHY: a cut inside a pair renders two broken glyphs.
    const value = "release-candidate-🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀";
    const split = splitForMiddleTruncate(value);
    expect(split?.tail).toBe("🚀".repeat(10));
    expect(split!.head + split!.tail).toBe(value);
  });
});
