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
}
