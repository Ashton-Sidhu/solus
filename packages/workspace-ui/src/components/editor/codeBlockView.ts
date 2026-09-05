import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { mount, unmount } from "svelte";
import CodeBlockLanguageSelect from "./CodeBlockLanguageSelect.svelte";
import { codeBlockPickerLanguage } from "./lib/code-block-language";
import { fenceLanguage } from "../conversation/lib/html-block";
import { z } from "zod";

const codeBlockLanguageSchema = z.string().nullable().catch(null);

/** The grammars registered in lowlight.ts, plus a "plain" escape hatch. Kept
 *  here as a literal rather than read off lowlight so the picker shows stable
 *  labels rather than raw grammar aliases. */
const LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "plain" },
  { value: "bash", label: "bash" },
  { value: "c", label: "c" },
  { value: "cpp", label: "c++" },
  { value: "css", label: "css" },
  { value: "go", label: "go" },
  { value: "java", label: "java" },
  { value: "javascript", label: "js" },
  { value: "json", label: "json" },
  { value: "markdown", label: "md" },
  { value: "python", label: "py" },
  { value: "rust", label: "rust" },
  { value: "shell", label: "shell" },
  { value: "sql", label: "sql" },
  { value: "typescript", label: "ts" },
  { value: "xml", label: "html" },
  { value: "yaml", label: "yaml" },
];

function control(label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "doc-code-block__btn";
  button.textContent = label;
  button.title = title;
  // Chrome, not content: a mousedown here must not move the caret into (or
  // out of) the block the control acts on.
  button.addEventListener("mousedown", (e) => e.preventDefault());
  return button;
}

/**
 * Code blocks carry their controls in the caption row where a filename would
 * already sit — language, wrap and copy — so focusing one adds no furniture.
 * Focus is signalled by the left rule turning terracotta instead.
 */
export const DocCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      const currentNode = { value: node };

      const dom = document.createElement("div");
      dom.className = "doc-code-block";

      const caption = document.createElement("div");
      caption.className = "doc-code-block__caption";
      caption.contentEditable = "false";

      const controls = document.createElement("div");
      controls.className = "doc-code-block__controls";

      // Markdown carries no filename on a fence, so the language is both the
      // resting caption and its picker. Mount the shared Select primitive here
      // so it uses the same menu surface and rows as dropdowns elsewhere.
      const languageTarget = document.createElement("div");
      const languagePicker = mount(CodeBlockLanguageSelect, {
        target: languageTarget,
        props: {
          initialValue: codeBlockPickerLanguage(
            codeBlockLanguageSchema.parse(currentNode.value.attrs.language),
          ),
          options: LANGUAGES,
          onValueChange: (value: string) => {
            const pos = getPos();
            if (pos == null) return;
            editor
              .chain()
              .command(({ tr }) => {
                tr.setNodeAttribute(pos, "language", value || null);
                return true;
              })
              .run();
            requestAnimationFrame(() => editor.commands.focus());
          },
        },
      });

      const wrap = control("wrap", "Wrap long lines");
      wrap.addEventListener("click", () => {
        const on = dom.classList.toggle("doc-code-block--wrap");
        wrap.classList.toggle("doc-code-block__btn--on", on);
      });

      // The reverse of the HTML block's "Show as code". An html fence the
      // content test read as a snippet — or one the author marked `source` —
      // is still something a reader may want to look at rather than read.
      const render = control("render", "Render this HTML");
      render.addEventListener("click", () => {
        const pos = getPos();
        if (pos == null) return;
        const html = currentNode.value.textContent;
        editor
          .chain()
          .focus()
          .command(({ tr, state }) => {
            const block = state.schema.nodes.htmlBlock?.create({ html, explicit: true });
            if (!block) return false;
            tr.replaceWith(pos, pos + currentNode.value.nodeSize, block);
            return true;
          })
          .run();
      });

      const copy = control("copy", "Copy code");
      copy.addEventListener("click", () => {
        void navigator.clipboard
          .writeText(currentNode.value.textContent)
          .then(() => {
            copy.textContent = "copied";
            setTimeout(() => (copy.textContent = "copy"), 1400);
          })
          .catch(() => {});
      });

      // Only an html fence earns it, and only where the schema has the node —
      // the prompt editor and the task description share this view without it.
      const syncRender = () => {
        const language = codeBlockLanguageSchema.parse(currentNode.value.attrs.language) ?? "";
        const show = !!editor.state.schema.nodes.htmlBlock && fenceLanguage(language) === "html";
        render.style.display = show ? "" : "none";
      };
      syncRender();

      controls.append(render, wrap, copy);
      caption.append(languageTarget, controls);

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.appendChild(code);
      dom.append(caption, pre);

      // "Focused" means the caret is inside this block. NodeView.update only
      // fires for content changes, so selection has to be watched separately.
      const syncFocus = () => {
        const pos = getPos();
        if (pos == null) return;
        const { from, to } = editor.state.selection;
        const end = pos + currentNode.value.nodeSize;
        dom.classList.toggle("doc-code-block--focused", from >= pos && to <= end);
      };
      editor.on("selectionUpdate", syncFocus);
      syncFocus();

      return {
        dom,
        contentDOM: code,
        // Clicks on the caption belong to the controls, never to the document.
        // The focused class is view-only state. If ProseMirror observes that
        // attribute change as document content, it dirties and redraws this
        // node view, which can feed another selection update back into
        // syncFocus. Structured blocks made that feedback loop pin Chromium's
        // renderer without surfacing an application error.
        ignoreMutation: (mutation) =>
          caption.contains(mutation.target) ||
          (mutation.type === "attributes" && mutation.target === dom),
        update: (updated) => {
          if (updated.type.name !== currentNode.value.type.name) return false;
          currentNode.value = updated;
          const next = codeBlockPickerLanguage(
            codeBlockLanguageSchema.parse(updated.attrs.language),
          );
          languagePicker.setLanguage(next);
          syncRender();
          syncFocus();
          return true;
        },
        destroy: () => {
          editor.off("selectionUpdate", syncFocus);
          void unmount(languagePicker);
        },
      };
    };
  },
});
