import type {
  PlanReference,
  SessionReference,
  WorkReference,
} from "../../../shared/types";
import type { ReferenceToken } from "./reference-tokens";

export interface TrackedReferences {
  planRefs: PlanReference[];
  workRefs: WorkReference[];
  sessionRefs: SessionReference[];
}

export interface AutocompleteEditor {
  textBeforeCursor(): string;
  cursorRect(): DOMRect | null;
  focus(): void;
  replaceTrigger(pattern: RegExp, replacement: string): boolean;
  insertReference(token: ReferenceToken, pattern: RegExp): boolean;
  unwrapFileReferenceBeforeCursor(): boolean;
  extractTrackedReferences(): TrackedReferences;
  isCaretAtStart(): boolean;
  /** Gates the arrow keys: → drills or completes only at the end of the line,
   *  so it is never hijacked while the caret is inside text. */
  isCaretAtLineEnd(): boolean;
}

export type AutocompleteSelectionAction = "activate" | "drill" | null;

/** Enter inserts any selected row. Tab does the same for individual items, but
 * retains the former file-browser behavior of drilling into directories. */
export function autocompleteSelectionAction(
  key: string,
  isDirectory: boolean,
): AutocompleteSelectionAction {
  if (key === "Tab" && isDirectory) return "drill";
  if (key === "Enter" || key === "Tab") return "activate";
  return null;
}
