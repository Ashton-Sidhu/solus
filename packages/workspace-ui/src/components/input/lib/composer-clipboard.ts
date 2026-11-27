import { HTML_ANCHOR, isComposerCode, restoreComposerLinks } from "@solus/client-core/composer-rich-text";
import { isOneReference } from "../../editor/reference-clipboard";
import type { ReferenceParseOptions } from "../../editor/reference-tokens";

export interface ComposerPaste {
  text: string;
  literal: boolean;
}

export function isPasteAsTextChord(event: KeyboardEvent): boolean {
  return event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
}

export function readComposerPaste(
  data: Pick<DataTransfer, "getData">,
  value: string,
  from: number,
  to: number,
  literal: boolean,
  references?: ReferenceParseOptions,
): ComposerPaste & { restored: boolean } {
  const plain = data.getData("text/plain");
  const html = literal ? "" : data.getData("text/html");
  const inCode = HTML_ANCHOR.test(html) && isComposerCode(value, from, to);
  const restored = inCode ? null : restoreComposerLinks(
    plain, html, references && ((source) => isOneReference(source, references)),
  );
  return { text: restored ?? plain, literal: literal || inCode, restored: restored !== null };
}
