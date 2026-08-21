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

  test("building the view subscribes to the host element and nothing else", () => {
    // WHY: `EditorState.create` runs the reference state field, which reads the
    // `referenceConfig` derived. Tracked, that made the view a dependent of the
    // slash-command list, so commands arriving after mount — exactly what a
    // session draft does — rebuilt the editor and dropped the user's caret.
    expect(source).toMatch(
      /const host = editorHost;\s*if \(!host\) return;\s*return untrack\(\(\) => \{[\s\S]*?new EditorView\(/,
    );
  });

  test("a reference config change repaints chips instead of rebuilding the view", () => {
    // WHY: the compartment holds the same extension value when only the config
    // behind it changed, so without an explicit refresh the chips would keep
    // rendering the slash commands the editor mounted with.
    expect(source).toMatch(/if \(referenceChips\) references\.refresh\(view\);/);
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
