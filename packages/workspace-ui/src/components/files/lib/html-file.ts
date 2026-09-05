export type HtmlFileViewMode = "preview" | "source";

export const HTML_FILE_VIEW_OPTIONS: {
  value: HtmlFileViewMode;
  label: string;
}[] = [
  { value: "preview", label: "Preview" },
  { value: "source", label: "Source" },
];

export const HTML_FILE_VIEW_MODE_KEY = "solus-html-file-view-mode";

export function isHtmlFile(path: string): boolean {
  return /\.(html|htm)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
}

/** Source wins when the reader asked for a line, or when the file arrived
 *  truncated: a preview of half a document is a misleading page, and a line
 *  number is a request to read the markup, not to look at it. */
export function initialHtmlFileViewMode(path: string, line?: number): HtmlFileViewMode {
  if (!isHtmlFile(path) || line) return "source";
  try {
    return localStorage.getItem(HTML_FILE_VIEW_MODE_KEY) === "source" ? "source" : "preview";
  } catch {
    return "preview";
  }
}

export function persistHtmlFileViewMode(mode: HtmlFileViewMode): void {
  try {
    localStorage.setItem(HTML_FILE_VIEW_MODE_KEY, mode);
  } catch {
    // The view still works when storage is unavailable.
  }
}
