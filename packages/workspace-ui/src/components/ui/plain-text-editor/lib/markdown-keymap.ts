import type { Command, KeyBinding } from "@codemirror/view";
import {
  defaultKeymap,
  deleteCharBackward,
  deleteCharForward,
  historyKeymap,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
} from "@codemirror/lang-markdown";
import {
  deleteReferenceBackward,
  deleteReferenceForward,
} from "./reference-decorations";
import type { ReferenceParseOptions } from "../../../editor/reference-tokens";

const markdownNewline: Command = (view) =>
  insertNewlineContinueMarkup(view) || insertNewlineAndIndent(view);

/** History plus CodeMirror's stock editing keys, minus `Mod-/`. That binding is
 *  `toggleComment`, which in a Markdown document wraps the line in `<!-- -->`.
 *  The composer is prose, and ⌘/ is the app's keyboard-shortcuts overlay
 *  (`global.show-shortcuts`) — CodeMirror does not check `defaultPrevented`, so
 *  leaving it bound fires both the overlay and the comment. */
export const composerBaseKeymap: readonly KeyBinding[] = [
  ...historyKeymap,
  ...defaultKeymap.filter((binding) => binding.key !== "Mod-/"),
];

export function markdownComposerKeymap(
  enterInsertsNewline: boolean,
  getReferenceOptions: () => ReferenceParseOptions,
): readonly KeyBinding[] {
  return [
    {
      key: "Enter",
      run: enterInsertsNewline ? markdownNewline : () => true,
    },
    { key: "Shift-Enter", run: markdownNewline },
    {
      key: "Backspace",
      run: (view) =>
        deleteReferenceBackward(view, getReferenceOptions()) ||
        deleteMarkupBackward(view) ||
        deleteCharBackward(view),
    },
    {
      key: "Delete",
      run: (view) =>
        deleteReferenceForward(view, getReferenceOptions()) ||
        deleteCharForward(view),
    },
  ];
}
