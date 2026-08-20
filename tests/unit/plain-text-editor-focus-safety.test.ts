import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/ui/plain-text-editor/plain-text-editor.svelte",
  ),
  "utf8",
);
const documentEditorSource = readFileSync(
  resolve(
    import.meta.dir,
    "../../packages/workspace-ui/src/components/editor/DocumentEditor.svelte",
  ),
  "utf8",
);

describe("plain text editor focus callbacks", () => {
  test("run after synchronous CodeMirror focus changes", () => {
    expect(source).toMatch(
      /focus\(\) \{\s*setFocused\(true\);\s*queueMicrotask\(\(\) => onFocus\?\.\(\)\);/,
    );
    expect(source).toMatch(
      /blur\(\) \{\s*setFocused\(false\);\s*queueMicrotask\(\(\) => onBlur\?\.\(\)\);/,
    );
  });

  test("Tiptap focus state changes run outside its synchronous transaction", () => {
    expect(documentEditorSource).toMatch(
      /editor\.on\("focus", \(\) => \{\s*queueMicrotask\(\(\) => \{\s*isFocused = true;\s*onFocus\?\.\(\);/,
    );
    expect(documentEditorSource).toMatch(
      /editor\.on\("blur", \(\) => \{\s*queueMicrotask\(\(\) => \{\s*isFocused = false;\s*onBlur\?\.\(\);/,
    );
  });
});
