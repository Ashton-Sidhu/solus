import { parseFileHref } from "../../../lib/filePreview";

interface LinkActivationModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
}

export type LinkActivation =
  | { kind: "file"; path: string; line?: number }
  | { kind: "open" }
  | { kind: "preview" };

/** A file path is a file on the host, not a web page: it opens in the file
 *  pane, like a file chip, and never goes to the operating system. */
export function linkActivation(
  href: string,
  modifiers: LinkActivationModifiers,
): LinkActivation {
  const file = parseFileHref(href);
  if (file) return { kind: "file", path: file.path, line: file.line };
  return modifiers.metaKey || modifiers.ctrlKey ? { kind: "open" } : { kind: "preview" };
}

export function linkDestinationLabel(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol === "mailto:") return url.pathname;
    return url.hostname.replace(/^www\./, "") || href;
  } catch {
    return href;
  }
}
