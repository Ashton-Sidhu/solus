/*
 * Trigger parsing. The composer text is the single source of truth: there is no
 * menu mode and no selected-category state. Everything the menu needs is
 * re-derived from the caret on each keystroke.
 *
 * The anchor survives across keystrokes so file and command queries can keep
 * their spaces. A space ends a `#` reference query and hands typing back to the
 * sentence. The caller re-validates the anchor each change and re-matches
 * TRIGGER_RE when it no longer points at a live trigger.
 */
import { kindForSlug, type RefKind } from "./kinds";

export type TriggerChar = "/" | "@" | "#";

export interface Trigger {
  char: TriggerChar;
  /** Index of the trigger character within the text before the caret. */
  anchor: number;
  /** Category drilled into. Empty at root; one deep is the whole hierarchy. */
  path: RefKind[];
  /** Text after the trigger and any scope slug. */
  query: string;
}

/** Opens a trigger at line start or after whitespace. */
export const TRIGGER_RE = /(^|\s)([/@#])([A-Za-z0-9._:#/~]*)$/;
const FILE_PATH_RE = /(^|\s)(@[^\s]*|~\/[^\s]*|\.\.?\/[^\s]*|\/[^\s]*)$/;

function isBareAbsoluteFilePath(run: string): boolean {
  if (!run.startsWith("/")) return false;
  // Keep `/foo` available to slash commands while still restoring absolute
  // paths once they look like paths. `@/foo` is always a file path.
  return run.includes("/", 1);
}

function fileRunQuery(run: string): string | null {
  if (run.startsWith("@")) return run.slice(1);
  if (
    run.startsWith("~/") ||
    run.startsWith("./") ||
    run.startsWith("../") ||
    isBareAbsoluteFilePath(run)
  )
    return run;
  return null;
}

/** Where a freshly typed trigger character sits, or null if the caret isn't in one. */
export function findAnchor(textBeforeCursor: string): number | null {
  const fileMatch = textBeforeCursor.match(FILE_PATH_RE);
  if (fileMatch) {
    const run = fileMatch[2];
    if (fileRunQuery(run) !== null)
      return textBeforeCursor.length - run.length;
  }
  const match = textBeforeCursor.match(TRIGGER_RE);
  return match ? textBeforeCursor.length - match[3].length - 1 : null;
}

/** Read the live trigger at `anchor`, or null when the anchor no longer holds one. */
export function readTrigger(
  textBeforeCursor: string,
  anchor: number | null,
): Trigger | null {
  if (anchor === null || anchor < 0 || anchor >= textBeforeCursor.length)
    return null;
  const char = textBeforeCursor.charAt(anchor);
  if (char !== "/" && char !== "@" && char !== "#" && char !== "." && char !== "~") return null;
  const run = textBeforeCursor.slice(anchor);
  const fileQuery = fileRunQuery(run);
  if (fileQuery !== null)
    return { char: "@", anchor, path: [], query: fileQuery };
  const rest = textBeforeCursor.slice(anchor + 1);

  // Only `#` scopes. An `@` query may contain `/` because it is a path, so the
  // split is never applied to it.
  if (char === "#") {
    if (/\s/.test(rest)) return null;
    const separator = rest.indexOf("/");
    if (separator >= 0) {
      const kind = kindForSlug(rest.slice(0, separator));
      if (kind)
        return {
          char,
          anchor,
          path: [kind.key],
          query: rest.slice(separator + 1),
        };
    }
  }
  if (char === "." || char === "~") return null;
  return { char, anchor, path: [], query: rest };
}

/*
 * Accepting a row replaces the whole trigger run — trigger character, scope and
 * query — so the editors' trigger-pattern API is fed a pattern matching exactly
 * that text. A query may hold spaces and a scope slug, which no static trigger
 * regex covers, so the run is matched literally.
 */
export function triggerRunPattern(
  textBeforeCursor: string,
  anchor: number,
): RegExp {
  const run = textBeforeCursor.slice(anchor);
  return new RegExp(`${run.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}
