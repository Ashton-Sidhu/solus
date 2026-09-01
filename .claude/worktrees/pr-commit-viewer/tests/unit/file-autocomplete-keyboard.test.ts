import { describe, expect, test } from "bun:test";
import { shouldUnwrapFileReferenceOnBackspace } from "../../src/renderer/components/editor/autocomplete.svelte";

function keyboardEvent(key: string) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };
}

describe("file autocomplete keyboard handling", () => {
  test("Backspace edits an active @path trigger instead of treating it as a file chip", () => {
    // WHY: @path text is parseable as a file reference while autocomplete is
    // open, but Backspace must still reach the editor and delete a character.
    expect(
      shouldUnwrapFileReferenceOnBackspace(
        keyboardEvent("Backspace"),
        true,
      ),
    ).toBe(false);
  });

  test("Backspace still unwraps an accepted file chip", () => {
    // WHY: the autocomplete fix must preserve the recovery path for editing a
    // file reference after it has been inserted and the menu has closed.
    expect(
      shouldUnwrapFileReferenceOnBackspace(
        keyboardEvent("Backspace"),
        false,
      ),
    ).toBe(true);
  });
});
