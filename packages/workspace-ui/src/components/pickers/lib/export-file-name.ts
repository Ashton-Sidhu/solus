/**
 * A portable, visible file name for a work being written out to the filesystem.
 * Titles are free text — separators, colons and emoji all reach here — so every
 * character that a file name cannot carry collapses to an underscore.
 */
export function exportFileName(title: string, extension: string, fallbackBase = "work"): string {
  const base = title.replace(/[^\w.\- ]+/g, "_").trim() || fallbackBase;
  return `${base}.${extension}`;
}
