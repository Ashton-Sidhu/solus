export type MarkdownFileViewMode = "rendered" | "source";

export const MARKDOWN_FILE_VIEW_OPTIONS: {
  value: MarkdownFileViewMode;
  label: string;
}[] = [
  { value: "rendered", label: "Editor" },
  { value: "source", label: "Markdown" },
];

export const MARKDOWN_FILE_VIEW_MODE_KEY = "solus-markdown-file-view-mode";

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
}

export function initialMarkdownFileViewMode(
  path: string,
  line?: number,
): MarkdownFileViewMode {
  if (!isMarkdownFile(path) || line) return "source";
  try {
    return localStorage.getItem(MARKDOWN_FILE_VIEW_MODE_KEY) === "source"
      ? "source"
      : "rendered";
  } catch {
    return "rendered";
  }
}

export function persistMarkdownFileViewMode(mode: MarkdownFileViewMode): void {
  try {
    localStorage.setItem(MARKDOWN_FILE_VIEW_MODE_KEY, mode);
  } catch {
    // The view still works when storage is unavailable.
  }
}

function pathWithoutQueryOrHash(path: string): string {
  return path.split(/[?#]/, 1)[0] ?? path;
}

export function markdownFileDirectory(filePath: string, cwd: string): string {
  const cleanPath = pathWithoutQueryOrHash(filePath);
  const directory = cleanPath.includes("/")
    ? cleanPath.slice(0, cleanPath.lastIndexOf("/"))
    : "";
  if (cleanPath.startsWith("/")) return directory || "/";
  return directory ? `${cwd.replace(/\/+$/, "")}/${directory}` : cwd;
}

/**
 * The title a markdown file gets when it is saved as a work: its first
 * top-level heading, else its file name without the extension. The heading is
 * what a reader calls the document; the file name is the fallback a draft
 * without one still deserves.
 */
export function workTitleForMarkdownFile(filePath: string, content: string): string {
  const heading = content.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  if (heading) return heading;
  const cleanPath = pathWithoutQueryOrHash(filePath);
  const fileName = cleanPath.slice(cleanPath.lastIndexOf("/") + 1);
  return fileName.replace(/\.(md|markdown)$/i, "") || "Untitled document";
}
