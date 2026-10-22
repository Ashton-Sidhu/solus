import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { parseFileHref } from "../../lib/filePreview";
import { tokenClassName } from "./tokenStyle";

const fileLinkKey = new PluginKey<DecorationSet>("fileLink");

export function fileLinkDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = node.marks.find((mark) => mark.type.name === "link");
    if (link && parseFileHref(link.attrs.href) !== null) {
      decorations.push(Decoration.inline(pos, pos + node.nodeSize, { class: tokenClassName("file", true) }));
    }
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * A markdown link to a file path shows as a file chip, as it does in the
 * conversation, not as a web link. Only the view changes: the link mark and
 * the saved markdown stay the same, and a click opens the file pane
 * (`linkActivation`).
 */
export const FileLinkExtension = Extension.create({
  name: "fileLink",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: fileLinkKey,
        state: {
          init: (_config, state) => fileLinkDecorations(state.doc),
          apply: (tr, decorations) =>
            tr.docChanged ? fileLinkDecorations(tr.doc) : decorations.map(tr.mapping, tr.doc),
        },
        props: {
          // @ts-expect-error Bun resolved duplicate ProseMirror package identities.
          decorations: (state) => fileLinkKey.getState(state),
        },
      }),
    ];
  },
});
