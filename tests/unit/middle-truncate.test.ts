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
    // timestamp suffix that tells it from its siblings, without pinning the
    // whole segment and pushing the prefix out.
    const split = splitForMiddleTruncate("sidhu/fix-cache-main-20260918-180825");
    expect(split?.tail).toBe("180825");
  });

  test("an automatic tail starts on a word, not inside one", () => {
    // WHY: `…er-machine` reads as a typo; `…machine` reads as the word it is.
    expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine")?.tail).toBe("machine");
    expect(splitForMiddleTruncate("t3/investigate-release-build-times")?.tail).toBe("times");
  });

  test("a last word too short to stand alone falls back to an earlier word", () => {
    // WHY: a two-letter tail tells nothing apart, so the tail grows back to a word.
    expect(splitForMiddleTruncate("t3/compare-long-featurenames-ab")?.tail).toBe("featurenames-ab");
  });

  test("a value with no word break near the cut keeps the fixed tail", () => {
    expect(splitForMiddleTruncate("t3/abcdefghijklmnopqrstuvwxyz")?.tail).toBe("qrstuvwxyz");
  });

  test("an explicit tail is never moved to a word", () => {
    // WHY: a caller that asks for a count needs that count, e.g. to align columns.
    expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine", 6)?.tail).toBe("achine");
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
