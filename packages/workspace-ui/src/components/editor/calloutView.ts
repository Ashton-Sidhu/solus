import { Callout, CALLOUT_KINDS, CALLOUT_LABELS, calloutKind, type CalloutKind } from "@solus/document-model/callout";

/** The kind after `kind`, in the order the label steps through them. */
export function nextCalloutKind(kind: CalloutKind): CalloutKind {
  return CALLOUT_KINDS[(CALLOUT_KINDS.indexOf(kind) + 1) % CALLOUT_KINDS.length];
}

/**
 * A callout in the editor: the prose band, with its label as the control that
 * changes its kind. The label shows the current kind; a click steps to the
 * next one, so every kind is reachable and the current one is always visible.
 */
export const DocCallout = Callout.extend({
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;

      const dom = document.createElement("div");
      dom.className = "prose-callout";
      dom.setAttribute("role", "note");

      const label = document.createElement("button");
      label.type = "button";
      label.className = "prose-callout-label";
      label.contentEditable = "false";
      // Chrome, not content: a mousedown must not move the caret.
      label.addEventListener("mousedown", (event) => event.preventDefault());
      label.addEventListener("click", () => {
        const pos = getPos();
        if (pos == null || !editor.isEditable) return;
        const kind = nextCalloutKind(calloutKind(current.attrs.kind));
        editor.chain().command(({ tr }) => {
          tr.setNodeMarkup(pos, undefined, { ...current.attrs, kind });
          return true;
        }).run();
      });

      const body = document.createElement("div");
      body.className = "prose-callout-body";
      dom.append(label, body);

      const paint = () => {
        const kind = calloutKind(current.attrs.kind);
        dom.dataset.kind = kind;
        label.textContent = CALLOUT_LABELS[kind];
        label.title = `${CALLOUT_LABELS[kind]}. Click for ${CALLOUT_LABELS[nextCalloutKind(kind)]}.`;
        label.disabled = !editor.isEditable;
      };
      paint();

      return {
        dom,
        contentDOM: body,
        ignoreMutation: (mutation) =>
          label.contains(mutation.target) || (mutation.type === "attributes" && mutation.target === dom),
        update: (updated) => {
          if (updated.type.name !== current.type.name) return false;
          current = updated;
          paint();
          return true;
        },
      };
    };
  },
});
