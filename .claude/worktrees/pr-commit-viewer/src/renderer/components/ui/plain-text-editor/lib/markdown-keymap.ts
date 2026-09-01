import type { Command, KeyBinding } from "@codemirror/view";
import {
  deleteCharBackward,
  deleteCharForward,
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
