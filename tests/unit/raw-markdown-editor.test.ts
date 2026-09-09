import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Editor, type EditorOptions } from "@pierre/diffs/edit";

// Execute the component's actual constructor against the installed library.
// No DOM is needed to check the attachment type and change-event contract.
test("raw Markdown uses a file editor and publishes the changed file contents", () => {
  const source = readFileSync(new URL(
    "../../packages/workspace-ui/src/components/editor/RawMarkdownEditor.svelte",
    import.meta.url,
  ), "utf8");
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const ast = ts.createSourceFile("editor.ts", script, ts.ScriptTarget.Latest, true);
  let constructor: ts.NewExpression | undefined;
  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === "Editor") {
      constructor = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!constructor) throw new Error("Missing raw Markdown editor constructor");
  let options: EditorOptions<"file", never, undefined> | undefined;
  class CapturedEditor extends Editor<"file", never> {
    constructor(type: "file", suppliedOptions: EditorOptions<"file", never, undefined>) {
      super(type, suppliedOptions);
      options = suppliedOptions;
    }
  }
  const changes: string[] = [];
  let inputs = 0;
  const expression = new Bun.Transpiler({ loader: "ts" }).transformSync(
    `const editor = ${constructor.getText(ast)};`,
  );
  const create = new Function("Editor", "onValueChange", "onInput", `
    let currentValue = "initial";
    const onFocus = undefined, onBlur = undefined;
    ${expression}
    return { editor, currentValue: () => currentValue };
  `);
  const result = create(CapturedEditor, (value: string) => changes.push(value), () => inputs++);
  expect(result.editor.type).toBe("file");
  options!.onChange!({
    file: { name: "document.md", contents: "# Updated", lang: "markdown" },
    changes: [], editor: result.editor, lineAnnotations: undefined,
  });
  expect(result.currentValue()).toBe("# Updated");
  expect(changes).toEqual(["# Updated"]);
  expect(inputs).toBe(1);
});
